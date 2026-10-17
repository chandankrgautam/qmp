package `in`.ncl.civilportal.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import retrofit2.Response

/** A refusal from the portal, in its own words. */
class PortalError(message: String, val status: Int) : Exception(message)

/** The body of a successful answer, or the portal's refusal as a PortalError. */
fun <T> ok(r: Response<T>): T {
    if (r.isSuccessful) return r.body() ?: throw PortalError("Empty answer from the portal", r.code())
    throw refusal(r)
}

/** For answers whose body the app does not need (204, or nothing it reads). */
fun done(r: Response<*>) { if (!r.isSuccessful) throw refusal(r) }

private fun refusal(r: Response<*>): PortalError {
    val body = r.errorBody()?.string()
    val text = runCatching {
        val o = Json.parseToJsonElement(body ?: "").jsonObject
        (o["error"] ?: o["detail"] ?: o["title"])?.jsonPrimitive?.content
    }.getOrNull()
    return PortalError(text ?: "The portal refused (${r.code()})", r.code())
}
