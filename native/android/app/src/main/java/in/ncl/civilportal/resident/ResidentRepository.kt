package `in`.ncl.civilportal.resident

import `in`.ncl.civilportal.api.identity.models.Me
import `in`.ncl.civilportal.api.maintenance.models.Category
import `in`.ncl.civilportal.api.maintenance.models.ColonyNotice
import `in`.ncl.civilportal.api.maintenance.models.MediaUploadUrlPostRequest.Purpose
import `in`.ncl.civilportal.api.maintenance.models.Ticket
import `in`.ncl.civilportal.api.maintenance.models.TicketDetail
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdFeedbackGet200Response
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdFeedbackPostRequest
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdMaterialsLineWithdrawPostRequest
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdObjectionsPostRequest
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdRejectPostRequest
import `in`.ncl.civilportal.api.maintenance.models.TicketsPostRequest
import `in`.ncl.civilportal.net.Portal
import `in`.ncl.civilportal.net.done
import `in`.ncl.civilportal.net.ok
import `in`.ncl.civilportal.photo.Photos
import `in`.ncl.civilportal.photo.Shot
import kotlinx.serialization.SerializationException
import java.util.UUID

/**
 * What a resident or custodian does in the portal: raise, follow, object
 * while work is under way, confirm and rate, reopen, contest a rejection.
 * Every rule (who may, when) is the server's; this only asks.
 */
class ResidentRepository(val portal: Portal, private val photos: Photos) {
    suspend fun me(): Me = ok(portal.auth.meGet())
    suspend fun categories(): List<Category> = ok(portal.catalogue.mastersCategoriesGet())
    suspend fun complaints(): List<Ticket> = ok(portal.tickets.ticketsGet(pageSize = 100)).items.orEmpty()
    suspend fun complaint(id: UUID): TicketDetail = ok(portal.tickets.ticketsIdGet(id))
    /** The civil office's live notices for the caller's colony; row security decides which. */
    suspend fun notices(): List<ColonyNotice> = ok(portal.notices.noticesGet()).items.orEmpty()

    /** The occupant's latest answer, or null before they have given one (the portal answers `null`). */
    suspend fun feedback(id: UUID): TicketsIdFeedbackGet200Response? =
        try { portal.tickets.ticketsIdFeedbackGet(id).let { if (it.isSuccessful) it.body() else { done(it); null } } }
        catch (e: SerializationException) { null }

    /**
     * Raise, then attach the photograph: the upload needs the complaint. A
     * photograph that fails to upload does not undo the complaint; the
     * caller is told, and the complaint stands.
     */
    suspend fun raise(subCategory: UUID, description: String?, emergency: Boolean, photos: List<Shot>): Raised {
        val t = ok(portal.tickets.ticketsPost(idempotencyKey = UUID.randomUUID().toString(),
            ticketsPostRequest = TicketsPostRequest(subCategoryId = subCategory, description = description?.ifBlank { null }, isEmergency = emergency)))
        val id = t.id ?: error("The portal did not return the complaint")
        val failed = photos.mapNotNull { shot -> runCatching { this.photos.attach(id, Purpose.COMPLAINT, shot) }.exceptionOrNull()?.message }
        return Raised(id, t.ticketNo ?: "", failed.firstOrNull()?.let { if (failed.size > 1) "${failed.size} photographs: $it" else it })
    }
    class Raised(val id: UUID, val ticketNo: String, val photoError: String?)

    suspend fun confirm(id: UUID, rating: Int?, comment: String?) =
        done(portal.tickets.ticketsIdFeedbackPost(id, TicketsIdFeedbackPostRequest(confirmed = true, rating = rating, comment = comment)))

    /** A photograph of what is still wrong is compulsory (design rule); it goes first, so a failed upload changes nothing. */
    suspend fun reopen(id: UUID, reason: String, shots: List<Shot>) {
        require(shots.isNotEmpty()) { "A photograph of what is still wrong is needed" }
        shots.forEach { photos.attach(id, Purpose.COMPLAINT, it) }
        ok(portal.lifecycle.ticketsIdReopenPost(id, TicketsIdRejectPostRequest(reason = reason)))
    }

    suspend fun object_(id: UUID, note: String, shots: List<Shot>) {
        shots.forEach { photos.attach(id, Purpose.OBJECTION, it) }
        ok(portal.objections.ticketsIdObjectionsPost(id, TicketsIdObjectionsPostRequest(note = note)))
    }

    suspend fun contest(id: UUID, reason: String) =
        ok(portal.disputes.ticketsIdContestPost(id, TicketsIdMaterialsLineWithdrawPostRequest(reason = reason)))
}
