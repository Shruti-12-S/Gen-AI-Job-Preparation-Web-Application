import { getAllInterviewReports, generateInterviewReport, getInterviewReportById, generateResumePdf } from "../services/interview.api"
import { useContext, useEffect, useState } from "react"
import { InterviewContext } from "../interview.context"
import { useParams } from "react-router"


export const useInterview = () => {

    const context = useContext(InterviewContext)
    const { interviewId } = useParams()
    const [ downloading, setDownloading ] = useState(false)

    if (!context) {
        throw new Error("useInterview must be used within an InterviewProvider")
    }

    const { loading, setLoading, report, setReport, reports, setReports } = context

    const generateReport = async ({ jobDescription, selfDescription, resumeFile }) => {
    if (loading) return null; // prevent spam (429 fix)

    setLoading(true)
    try {
        const response = await generateInterviewReport({ jobDescription, selfDescription, resumeFile })

        // 🔥 normalize response (works for BOTH cases)
        const data = response?.data || response

        if (!data || !data.interviewReport) {
            throw new Error("Invalid API response")
        }

        setReport(data.interviewReport)
        return data.interviewReport

    } catch (error) {
        console.log("Generate Error:", error)
        return null
    } finally {
        setLoading(false)
    }
}

    const getReportById = async (interviewId) => {
        setLoading(true)
        let response = null
        try {
            response = await getInterviewReportById(interviewId)
            setReport(response.interviewReport)
        } catch (error) {
            console.log(error)
        } finally {
            setLoading(false)
        }
        return response.interviewReport
    }

    const getReports = async () => {
        setLoading(true)
        let response = null
        try {
            response = await getAllInterviewReports()
            setReports(response.interviewReports)
        } catch (error) {
            console.log(error)
        } finally {
            setLoading(false)
        }

        return response.interviewReports
    }

    const getResumePdf = async (interviewReportId) => {
        if (downloading) return
        setDownloading(true)
        try {
            const response = await generateResumePdf({ interviewReportId })
            const url = window.URL.createObjectURL(new Blob([ response ], { type: "application/pdf" }))
            const link = document.createElement("a")
            link.href = url
            link.setAttribute("download", `resume_${interviewReportId}.pdf`)
            document.body.appendChild(link)
            link.click()
            link.remove()
            window.URL.revokeObjectURL(url)
        }
        catch (error) {
            console.error("Download Resume Error:", error)
            let message = "Failed to download resume. Please try again."
            if (error.response && error.response.data instanceof Blob) {
                try {
                    const text = await error.response.data.text()
                    const json = JSON.parse(text)
                    if (json.message) message = json.message
                } catch (e) {
                    // Blob was not JSON
                }
            } else if (error.message) {
                message = error.message
            }
            alert(message)
        } finally {
            setDownloading(false)
        }
    }

    useEffect(() => {
        if (interviewId) {
            getReportById(interviewId)
        } else {
            getReports()
        }
    }, [ interviewId ])

    return { loading, downloading, report, reports, generateReport, getReportById, getReports, getResumePdf }

}