const { GoogleGenAI, Type } = require("@google/genai")
const { z } = require("zod")
const puppeteer = require("puppeteer")

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_GENAI_API_KEY
})

const GEMINI_MODEL = process.env.GOOGLE_GENAI_MODEL || "gemini-3-flash-preview"

// ================= SCHEMA =================
const interviewReportSchema = z.object({
    matchScore: z.number(),
    technicalQuestions: z.array(z.object({
        question: z.string(),
        intention: z.string(),
        answer: z.string()
    })),
    behavioralQuestions: z.array(z.object({
        question: z.string(),
        intention: z.string(),
        answer: z.string()
    })),
    skillGaps: z.array(z.object({
        skill: z.string(),
        severity: z.enum(["low", "medium", "high"])
    })),
    preparationPlan: z.array(z.object({
        day: z.number(),
        focus: z.string(),
        tasks: z.array(z.string())
    })),
    title: z.string()
})

const questionResponseSchema = {
    type: Type.OBJECT,
    properties: {
        question: { type: Type.STRING },
        intention: { type: Type.STRING },
        answer: { type: Type.STRING }
    },
    required: ["question", "intention", "answer"]
}

const interviewReportResponseSchema = {
    type: Type.OBJECT,
    properties: {
        matchScore: { type: Type.NUMBER },
        title: { type: Type.STRING },
        technicalQuestions: {
            type: Type.ARRAY,
            minItems: "5",
            maxItems: "10",
            items: questionResponseSchema
        },
        behavioralQuestions: {
            type: Type.ARRAY,
            minItems: "5",
            maxItems: "10",
            items: questionResponseSchema
        },
        skillGaps: {
            type: Type.ARRAY,
            minItems: "2",
            maxItems: "5",
            items: {
                type: Type.OBJECT,
                properties: {
                    skill: { type: Type.STRING },
                    severity: {
                        type: Type.STRING,
                        format: "enum",
                        enum: ["low", "medium", "high"]
                    }
                },
                required: ["skill", "severity"]
            }
        },
        preparationPlan: {
            type: Type.ARRAY,
            minItems: "7",
            maxItems: "7",
            items: {
                type: Type.OBJECT,
                properties: {
                    day: { type: Type.NUMBER },
                    focus: { type: Type.STRING },
                    tasks: {
                        type: Type.ARRAY,
                        minItems: "1",
                        items: { type: Type.STRING }
                    }
                },
                required: ["day", "focus", "tasks"]
            }
        }
    },
    required: [
        "matchScore",
        "title",
        "technicalQuestions",
        "behavioralQuestions",
        "skillGaps",
        "preparationPlan"
    ]
}

const resumePdfSchema = z.object({
    html: z.string()
})

const resumePdfResponseSchema = {
    type: Type.OBJECT,
    properties: {
        html: { type: Type.STRING }
    },
    required: ["html"]
}

function extractResponseText(response) {
    const partsText = response?.candidates?.[0]?.content?.parts
        ?.map(part => part?.text || "")
        .join("")

    if (partsText) {
        return partsText
    }

    const text = typeof response?.text === "function"
        ? response.text()
        : response?.text

    return typeof text === "string" ? text : ""
}

function parseJsonResponse(response, label) {
    const rawText = extractResponseText(response)

    console.log(`${label} RAW TEXT:`, rawText)

    const cleanedText = rawText
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim()

    try {
        return JSON.parse(cleanedText)
    } catch (err) {
        console.error(`${label} JSON Parse Error:`, cleanedText)
        throw new Error(`Invalid JSON from ${label}`)
    }
}

// ================= REPAIR FUNCTION =================
function repairData(data) {
    data = data && typeof data === "object" && !Array.isArray(data)
        ? data
        : {}

    const isValidString = (val) =>
        typeof val === "string" && val.trim().length > 0

    return {
        matchScore: Number(data.matchScore) || 0,
        title: isValidString(data.title) ? data.title : "Unknown Role",

        technicalQuestions: (data.technicalQuestions || [])
            .filter(q => q?.question || q?.intention || q?.answer)
            .map(q => ({
                question: isValidString(q?.question)
                    ? q.question
                    : "Explain a relevant technical concept",
                intention: isValidString(q?.intention)
                    ? q.intention
                    : "To evaluate understanding of fundamentals",
                answer: isValidString(q?.answer)
                    ? q.answer
                    : "Provide a structured explanation with examples"
            })),

        behavioralQuestions: (data.behavioralQuestions || [])
            .filter(q => q?.question || q?.intention || q?.answer)
            .map(q => ({
                question: isValidString(q?.question)
                    ? q.question
                    : "Describe a challenging situation you handled",
                intention: isValidString(q?.intention)
                    ? q.intention
                    : "To assess problem-solving and behavior",
                answer: isValidString(q?.answer)
                    ? q.answer
                    : "Use STAR method to explain situation clearly"
            })),

        skillGaps: (data.skillGaps || [])
            .filter(s => s?.skill)
            .map(s => ({
                skill: isValidString(s?.skill) ? s.skill : "General Development",
                severity: ["low", "medium", "high"].includes(s?.severity)
                    ? s.severity
                    : "medium"
            })),

        preparationPlan: (data.preparationPlan || [])
            .filter(p => p?.focus || (p?.tasks && p.tasks.length > 0))
            .map(p => {
                const tasks = Array.isArray(p?.tasks)
                    ? p.tasks.filter(isValidString)
                    : []

                return {
                    day: Number(p?.day) || 1,
                    focus: isValidString(p?.focus)
                        ? p.focus
                        : "General preparation",
                    tasks: tasks.length > 0 ? tasks : ["Revise core concepts"]
                }
            })
    }
}

// ================= CORE FUNCTION =================
async function generateInterviewReport({ resume, selfDescription, jobDescription }) {

    const prompt = `
You are a backend API that returns STRICT JSON only.

Follow this EXACT structure:

{
  "matchScore": number,
  "title": string,
  "technicalQuestions": [
    { "question": string, "intention": string, "answer": string }
  ],
  "behavioralQuestions": [
    { "question": string, "intention": string, "answer": string }
  ],
  "skillGaps": [
    { "skill": string, "severity": "low" | "medium" | "high" }
  ],
  "preparationPlan": [
    { "day": number, "focus": string, "tasks": string[] }
  ]
}

STRICT RULES:
- Return ONLY JSON
- Do NOT return arrays of strings
- Each array MUST contain objects
- Do NOT skip any field
- Do NOT add extra fields
- severity must be exactly: "low", "medium", "high"
- title must be the actual job role title from the job description
- title must be concise, for example: "Frontend Developer" or "Data Analyst"

COUNT RULES:
- technicalQuestions: 5 to 10
- behavioralQuestions: 5 to 10
- skillGaps: 2 to 5
- preparationPlan: exactly 7 days
- tasks MUST be array of strings

Candidate:
Resume: ${resume}
Self Description: ${selfDescription}
Job Description: ${jobDescription}
`

    const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: interviewReportResponseSchema,
        }
    })

    // ================= PARSE =================
    const parsed = parseJsonResponse(response, "AI")

    // ================= REPAIR =================
    const repaired = repairData(parsed)

    console.log("AI DATA AFTER REPAIR:", repaired)

    // ================= EMPTY CHECK (TRIGGERS RETRY) =================
    const isEmpty = (arr) => !Array.isArray(arr) || arr.length === 0

    if (
        isEmpty(repaired.technicalQuestions) ||
        isEmpty(repaired.behavioralQuestions) ||
        isEmpty(repaired.skillGaps) ||
        isEmpty(repaired.preparationPlan)
    ) {
        throw new Error("Incomplete AI data")
    }

    // ================= VALIDATE =================
    const validated = interviewReportSchema.safeParse(repaired)

    if (!validated.success) {
        console.error("Parsed Data:", parsed)
        console.error("Repaired Data:", repaired)
        console.error("Zod Error:", validated.error.format())
        throw new Error("Schema validation failed")
    }

    return validated.data
}

// ================= RETRY WRAPPER =================
async function generateInterviewReportWithRetry(input, retries = 2) {
    let lastError

    for (let i = 0; i <= retries; i++) {
        try {
            return await generateInterviewReport(input)
        } catch (err) {
            lastError = err
            console.log(`Retry ${i + 1}:`, err.message)
        }
    }

    throw new Error(lastError?.message || "Failed after retries")
}

// ================= PDF =================
async function generatePdfFromHtml(htmlContent) {
    let browser

    try {
        browser = await puppeteer.launch()
        const page = await browser.newPage()
        await page.setContent(htmlContent, { waitUntil: "networkidle0" })

        return await page.pdf({
            format: "A4",
            margin: {
                top: "20mm",
                bottom: "20mm",
                left: "15mm",
                right: "15mm"
            }
        })
    } finally {
        if (browser) {
            await browser.close()
        }
    }
}

// ================= RESUME =================
async function generateResumePdf({ resume, selfDescription, jobDescription }) {

    const prompt = `
Return ONLY JSON:
{ "html": string }

Generate a professional ATS-friendly resume in HTML.

Resume: ${resume}
Self Description: ${selfDescription}
Job Description: ${jobDescription}
`

    const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: resumePdfResponseSchema,
        }
    })

    const parsed = parseJsonResponse(response, "resume generator")
    const validated = resumePdfSchema.safeParse(parsed)

    if (!validated.success) {
        console.error("Resume generator Zod Error:", validated.error.format())
        throw new Error("Resume generator schema validation failed")
    }

    return generatePdfFromHtml(validated.data.html)
}

module.exports = {
    generateInterviewReportWithRetry,
    generateResumePdf
}
