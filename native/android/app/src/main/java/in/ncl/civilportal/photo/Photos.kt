package `in`.ncl.civilportal.photo

import `in`.ncl.civilportal.api.maintenance.models.MediaIdConfirmPostRequest
import `in`.ncl.civilportal.api.maintenance.models.MediaUploadUrlPostRequest
import `in`.ncl.civilportal.net.Portal
import `in`.ncl.civilportal.net.PortalError
import `in`.ncl.civilportal.net.done
import `in`.ncl.civilportal.net.ok
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.math.BigDecimal
import java.security.MessageDigest
import java.util.UUID

/**
 * The portal's two-step upload: ask for a signed link for this complaint and
 * purpose, send the bytes, then confirm with their SHA-256. The portal checks
 * the bytes against the fingerprint before anything in the lifecycle accepts
 * the photograph, and again whenever it is served.
 */
class Photos(private val portal: Portal) {
    suspend fun attach(ticketId: UUID, purpose: MediaUploadUrlPostRequest.Purpose, shot: Shot, place: Place? = shot.place): UUID {
        // every photograph records where it was taken (user's decision, 2026-10-12)
        val at = place ?: throw PortalError("This photograph has no location. Take it again once the location is found.", 422)
        val link = ok(portal.media.mediaUploadUrlPost(MediaUploadUrlPostRequest(
            ticketId = ticketId, purpose = purpose, contentType = MediaUploadUrlPostRequest.ContentType.imageSlashJpeg)))
        val mediaId = link.mediaId ?: error("The portal gave no upload link")
        withContext(Dispatchers.IO) { portal.putBytes(link.uploadUrl ?: error("The portal gave no upload link"), shot.jpeg, "image/jpeg") }
        done(portal.media.mediaIdConfirmPost(mediaId, MediaIdConfirmPostRequest(
            capturedAt = shot.capturedAt, contentHash = sha256(shot.jpeg), captureVerified = true,
            latitude = BigDecimal.valueOf(at.latitude), longitude = BigDecimal.valueOf(at.longitude),
            gpsAccuracyM = BigDecimal.valueOf(at.accuracyM))))
        return mediaId
    }

    companion object {
        fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
