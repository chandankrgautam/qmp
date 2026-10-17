package `in`.ncl.civilportal.overseer

import `in`.ncl.civilportal.api.maintenance.models.DevicesAssignableGet200ResponseInner
import `in`.ncl.civilportal.api.maintenance.models.InspectionsQueueGet200Response
import `in`.ncl.civilportal.api.maintenance.models.JobCard
import `in`.ncl.civilportal.api.maintenance.models.Ticket
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdAssignPostRequest
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdRejectPostRequest
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdVerifyPostRequest
import `in`.ncl.civilportal.api.maintenance.models.MediaUploadUrlPostRequest.Purpose
import `in`.ncl.civilportal.api.maintenance.models.TicketDetail
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdInspectPostRequest
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdMaterialsGet200Response
import `in`.ncl.civilportal.net.Portal
import `in`.ncl.civilportal.net.ok
import `in`.ncl.civilportal.photo.Photos
import `in`.ncl.civilportal.photo.Shot
import java.util.UUID

/**
 * The Civil Overseer's work on the phone: verifying, rejecting and assigning
 * (user's request, 2026-10-15, so work moves without waiting for a desk), and
 * the inspection (README §3, controls 1, 2 and 8): the queue
 * in the department's order, the inspection photograph taken here, on site,
 * and the verdict — accepted, or sent back with a remark — then closure.
 * Accepting is refused by the database from anything but a phone's own key,
 * so this is where it is done. Every rule is the server's; this only asks.
 */
class OverseerRepository(val portal: Portal, private val photos: Photos) {
    /** In the department's order — emergencies, priority, premises type, verification date — never the claim's (control 8). */
    suspend fun queue(): InspectionsQueueGet200Response = ok(portal.inspection.inspectionsQueueGet(pageSize = 100))

    suspend fun job(id: UUID): TicketDetail = ok(portal.tickets.ticketsIdGet(id))

    /** The Area's live complaints, each with the actions this role may take on it (the server's transition table). */
    suspend fun complaints(): List<Ticket> = ok(portal.tickets.ticketsGet(pageSize = 100)).items.orEmpty()

    /** Fixes the SLA from the SLA table, as the database does; nothing is sent that could set it (control 4). */
    suspend fun verify(id: UUID) { ok(portal.lifecycle.ticketsIdVerifyPost(id, TicketsIdVerifyPostRequest())) }

    /** The reason is compulsory and the occupant sees it. */
    suspend fun reject(id: UUID, reason: String) { ok(portal.lifecycle.ticketsIdRejectPost(id, TicketsIdRejectPostRequest(reason = reason.trim()))) }

    /** Contractor supervisors of the caller's Area, with their firm and open jobs; row security decides who is listed. */
    suspend fun supervisors(): List<DevicesAssignableGet200ResponseInner> = ok(portal.lifecycle.devicesAssignableGet())

    suspend fun assign(id: UUID, supervisor: UUID, reason: String?) {
        ok(portal.lifecycle.ticketsIdAssignPost(id, TicketsIdAssignPostRequest(supervisorId = supervisor, reason = reason?.trim()?.ifBlank { null })))
    }

    /**
     * The job card: who the work is with (supervisor and firm) and the life of
     * the job, round by round. Prepared at the first assignment, so a complaint
     * not yet assigned has none (null). Never shown to the occupant or contractor.
     */
    suspend fun jobCard(id: UUID): JobCard? = portal.jobCards.ticketsIdJobCardGet(id).let { if (it.isSuccessful) it.body() else null }

    suspend fun materials(id: UUID): TicketsIdMaterialsGet200Response = ok(portal.materials.ticketsIdMaterialsGet(id))

    /** The inspecting Overseer's own photograph, located, taken after the claim (control 2). */
    suspend fun photograph(id: UUID, shot: Shot) { photos.attach(id, Purpose.INSPECTION, shot) }

    suspend fun accept(id: UUID, remark: String?) {
        ok(portal.inspection.ticketsIdInspectPost(id, TicketsIdInspectPostRequest(accepted = true, remark = remark?.ifBlank { null })))
    }

    suspend fun sendBack(id: UUID, remark: String) {
        ok(portal.inspection.ticketsIdInspectPost(id, TicketsIdInspectPostRequest(accepted = false, remark = remark.trim())))
    }

    suspend fun close(id: UUID) { ok(portal.lifecycle.ticketsIdClosePost(id)) }
}
