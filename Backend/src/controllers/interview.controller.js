const pdfParse = require("pdf-parse")
const { generateInterviewReportWithRetry, generateResumePdf } = require("../services/ai.service")
const interviewReportModel = require("../models/interviewReport.model")

function normalizeTitle(title) {
    if (typeof title !== "string") {
        return ""
    }

    const trimmedTitle = title.trim()

    const invalidTitles = [ "undefined", "null", "untitled position", "unknown role" ]

    if (!trimmedTitle || invalidTitles.includes(trimmedTitle.toLowerCase())) {
        return ""
    }

    return trimmedTitle
}

function extractTitleFromJobDescription(jobDescription) {
    if (typeof jobDescription !== "string") {
        return ""
    }

    const normalizedText = jobDescription.replace(/\r/g, "").trim()
    const labeledTitle = normalizedText.match(
        /(?:job\s*title|position|role|designation)\s*[:\-]\s*([^\n|,]+)/i
    )

    if (labeledTitle) {
        return normalizeTitle(labeledTitle[1])
    }

    const firstUsefulLine = normalizedText
        .split("\n")
        .map(line => line.trim())
        .find(line => line && line.length <= 90)

    return normalizeTitle(firstUsefulLine)
}

async function ensureReportTitle(interviewReport) {
    const currentTitle = normalizeTitle(interviewReport.title)

    if (currentTitle) {
        return currentTitle
    }

    const repairedTitle =
        extractTitleFromJobDescription(interviewReport.jobDescription) ||
        "Untitled Position"

    interviewReport.title = repairedTitle
    await interviewReportModel.updateOne(
        { _id: interviewReport._id },
        { $set: { title: repairedTitle } }
    )

    return repairedTitle
}

/**
 * @description Controller to generate interview report based on user self description, resume and job description.
 */
async function generateInterViewReportController(req, res) {
    try {
        // ================= PDF PARSE =================
        if (!req.file) {
            return res.status(400).json({ message: "Resume file is required" })
        }

        const resumeContent = await (
            new pdfParse.PDFParse(Uint8Array.from(req.file.buffer))
        ).getText()

        const { selfDescription, jobDescription, title } = req.body

        // ================= AI CALL =================
        const aiData = await generateInterviewReportWithRetry({
            resume: resumeContent.text,
            selfDescription,
            jobDescription
        })

        // ================= HARD VALIDATION =================
        const isEmpty = (arr) => !Array.isArray(arr) || arr.length === 0

        if (
            isEmpty(aiData.technicalQuestions) ||
            isEmpty(aiData.behavioralQuestions) ||
            isEmpty(aiData.skillGaps) ||
            isEmpty(aiData.preparationPlan)
        ) {
            console.error("AI returned incomplete data:", aiData)
            return res.status(422).json({
                message: "AI returned incomplete data. Please try again."
            })
        }

        // ================= DEBUG LOG =================
        console.log("FINAL DATA BEFORE SAVE:", JSON.stringify(aiData, null, 2))

        const reportTitle =
            normalizeTitle(title) ||
            normalizeTitle(aiData.title) ||
            extractTitleFromJobDescription(jobDescription) ||
            "Untitled Position"

        // ================= SAVE =================
        const interviewReport = await interviewReportModel.create({
            user: req.user.id,
            title: reportTitle,
            resume: resumeContent.text,
            selfDescription,
            jobDescription,

            // explicitly map instead of spreading
            matchScore: aiData.matchScore,
            technicalQuestions: aiData.technicalQuestions,
            behavioralQuestions: aiData.behavioralQuestions,
            skillGaps: aiData.skillGaps,
            preparationPlan: aiData.preparationPlan
        })

        return res.status(201).json({
            message: "Interview report generated successfully.",
            interviewReport
        })

    } catch (err) {
        console.error("Controller Error:", err)

        return res.status(500).json({
            message: err.message || "Internal Server Error"
        })
    }
}

/**
 * @description Controller to get interview report by interviewId.
 */
async function getInterviewReportByIdController(req, res) {

    const { interviewId } = req.params

    const interviewReport = await interviewReportModel.findOne({ _id: interviewId, user: req.user.id })

    if (!interviewReport) {
        return res.status(404).json({
            message: "Interview report not found."
        })
    }

    await ensureReportTitle(interviewReport)

    res.status(200).json({
        message: "Interview report fetched successfully.",
        interviewReport
    })
}


/**
 * @description Controller to get all interview reports of logged in user.
 */
async function getAllInterviewReportsController(req, res) {
    const interviewReports = await interviewReportModel.find({ user: req.user.id }).sort({ createdAt: -1 }).select("-resume -selfDescription -__v -technicalQuestions -behavioralQuestions -skillGaps -preparationPlan")

    await Promise.all(interviewReports.map(ensureReportTitle))

    const safeInterviewReports = interviewReports.map(report => {
        const reportObject = report.toObject()
        delete reportObject.jobDescription
        return reportObject
    })

    res.status(200).json({
        message: "Interview reports fetched successfully.",
        interviewReports: safeInterviewReports
    })
}


/**
 * @description Controller to generate resume PDF based on user self description, resume and job description.
 */
async function generateResumePdfController(req, res) {
    const { interviewReportId } = req.params

    const interviewReport = await interviewReportModel.findById(interviewReportId)

    if (!interviewReport) {
        return res.status(404).json({
            message: "Interview report not found."
        })
    }

    const { resume, jobDescription, selfDescription } = interviewReport

    const pdfBuffer = await generateResumePdf({ resume, jobDescription, selfDescription })

    res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=resume_${interviewReportId}.pdf`
    })

    res.send(pdfBuffer)
}

module.exports = { generateInterViewReportController, getInterviewReportByIdController, getAllInterviewReportsController, generateResumePdfController }
