package `in`.ncl.civilportal.contractor

import `in`.ncl.civilportal.api.identity.models.Me
import `in`.ncl.civilportal.api.maintenance.models.Material
import `in`.ncl.civilportal.api.maintenance.models.MaterialLine
import `in`.ncl.civilportal.api.maintenance.models.MediaUploadUrlPostRequest.Purpose
import `in`.ncl.civilportal.api.maintenance.models.Ticket
import `in`.ncl.civilportal.api.maintenance.models.TicketDetail
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdMaterialsGet200Response
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdMaterialsLineWithdrawPostRequest
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdMaterialsPostRequest
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdMeasurementsGet200ResponseItemsInner
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdStartPostRequest
import `in`.ncl.civilportal.net.Portal
import `in`.ncl.civilportal.net.ok
import `in`.ncl.civilportal.photo.Photos
import `in`.ncl.civilportal.photo.Shot
import java.math.BigDecimal
import java.util.UUID

/**
 * What a contractor supervisor does in the portal (README §2): start the
 * work naming the workmen, photograph before and after, record materials
 * used while the work is under way, and CLAIM completion. Never close: the
 * Civil Overseer inspects and closes. Every rule (who may, when, how many
 * photographs) is the server's and the database's; this only asks.
 */
class ContractorRepository(val portal: Portal, private val photos: Photos) {
    suspend fun me(): Me = ok(portal.auth.meGet())

    /** The jobs in hand: assigned, under way, sent back, or claimed and waiting for inspection. */
    /** Work finished — accepted on inspection or closed — newest first (user's request, 2026-10-15). */
    suspend fun completed(): List<Ticket> =
        ok(portal.tickets.ticketsGet(pageSize = 100)).items.orEmpty()
            .filter { it.state?.value in setOf("INSPECTED_ACCEPTED", "CLOSED") }
            .sortedByDescending { it.closedAt ?: it.inspectedAt }

    /** The firm's supervisors by their role assignment, for naming who holds each job; row security keeps it to the firm's contract. */
    suspend fun supervisors(): Map<java.util.UUID, String> =
        ok(portal.lifecycle.devicesAssignableGet()).mapNotNull { s -> s.actorId?.let { it to (s.personName ?: "Supervisor") } }.toMap()

    suspend fun jobs(): List<TicketDetail> =
        ok(portal.tickets.ticketsGet(pageSize = 100)).items.orEmpty()
            .filter { it.state?.value in LIVE }
            .mapNotNull { it.id }.map { job(it) }

    suspend fun job(id: UUID): TicketDetail = ok(portal.tickets.ticketsIdGet(id))

    suspend fun start(id: UUID, workmen: String) {
        ok(portal.lifecycle.ticketsIdStartPost(id, TicketsIdStartPostRequest(workmenAssigned = workmen.trim())))
    }

    /** A claim only: the Overseer inspects it next. */
    suspend fun complete(id: UUID) { ok(portal.lifecycle.ticketsIdCompletePost(id)) }

    suspend fun photograph(id: UUID, after: Boolean, shot: Shot) {
        photos.attach(id, if (after) Purpose.COMPLETION else Purpose.BEFORE, shot)
    }

    suspend fun materials(id: UUID): TicketsIdMaterialsGet200Response = ok(portal.materials.ticketsIdMaterialsGet(id))

    private var master: List<Material>? = null
    suspend fun master(): List<Material> = master ?: ok(portal.materials.materialsGet()).also { master = it }

    suspend fun claim(id: UUID, material: UUID, qty: BigDecimal): MaterialLine =
        ok(portal.materials.ticketsIdMaterialsPost(id, TicketsIdMaterialsPostRequest(materialId = material, qtyClaimed = qty)))

    suspend fun withdraw(id: UUID, line: UUID, reason: String): MaterialLine =
        ok(portal.materials.ticketsIdMaterialsLineWithdrawPost(id, line, TicketsIdMaterialsLineWithdrawPostRequest(reason = reason.trim())))

    /** What Civil measured on the job, once accepted; nothing (not an error) where there is nothing to show. */
    suspend fun measured(id: UUID): List<TicketsIdMeasurementsGet200ResponseItemsInner> {
        val r = portal.measurements.ticketsIdMeasurementsGet(id)
        if (r.code() == 404 || r.code() == 403) return emptyList()
        return ok(r).items.orEmpty().filter { it.measurement != null }
    }

    companion object {
        val LIVE = setOf("ASSIGNED", "IN_PROGRESS", "REWORK", "WORK_COMPLETED")
    }
}
