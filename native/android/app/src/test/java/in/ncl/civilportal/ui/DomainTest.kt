package `in`.ncl.civilportal.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.OffsetDateTime

/** The phone must read the clock as the web does (web/src/lib/domain.ts). */
class DomainTest {
    private val now = OffsetDateTime.parse("2026-10-09T10:00:00+05:30")

    @Test fun noRingBeforeVerificationOrOnceOutOfTheOpenStates() {
        assertNull(deadlineSla(null, 2880, "RAISED", now))
        assertNull(deadlineSla(now.plusHours(5), 2880, "CLOSED", now))
    }

    @Test fun lastQuarterOfTheWindowIsAtRiskAndPastTheDeadlineIsLate() {
        assertEquals(Tone.OK, deadlineSla(now.plusHours(30), 2880, "ASSIGNED", now)!!.tone)
        assertEquals(Tone.RISK, deadlineSla(now.plusHours(10), 2880, "ASSIGNED", now)!!.tone)
        val late = deadlineSla(now.minusHours(3), 2880, "IN_PROGRESS", now)!!
        assertEquals(Tone.BAD, late.tone)
        assertEquals(1f, late.fraction)
    }

    @Test fun timeLeftReadsInHoursThenDaysAndLateWithAPlus() {
        assertEquals("1h", slaText(10.0))
        assertEquals("5h", slaText(5 * 60.0))
        assertEquals("3d", slaText(72 * 60.0))
        assertEquals("+2h", slaText(-120.0))
    }

    /* The contractor's own clock (decision 2026-09-25): only time in their hands, all rounds. */
    @Test fun contractorClockAddsTheRunningRoundToEarlierRounds() {
        // 10 h used in earlier rounds, the current round open 2 h, window 48 h
        val c = contractorSla(2880, 600, now.minusHours(2), "IN_PROGRESS", null, now)!!
        assertEquals(720.0, c.usedMinutes, 0.01)
        assertEquals(2160.0, c.leftMinutes, 0.01)
        assertEquals(Tone.OK, c.tone)
        assertEquals(true, c.running)
    }

    @Test fun contractorClockStopsWithTheClaimAndTheVerdictDecidesTheTone() {
        val stopped = contractorSla(2880, 3000, null, "WORK_COMPLETED", null, now)!!
        assertEquals(false, stopped.running)
        assertEquals(Tone.BAD, stopped.tone)
        assertEquals(1f, stopped.fraction)
        assertEquals(Tone.OK, contractorSla(2880, 3000, null, "CLOSED", true, now)!!.tone)
        assertEquals(Tone.RISK, contractorSla(2880, 2400, null, "IN_PROGRESS", null, now)!!.tone)
        assertNull(contractorSla(null, 0, null, "ASSIGNED", null, now))
    }

    /* At most three before and three after in each round; a send-back starts the count again. */
    @Test fun onlyThisRoundsPhotographsCount() {
        val start = now.minusHours(1)
        val media = listOf("BEFORE" to now.minusHours(5), "BEFORE" to now.minusMinutes(30),
            "COMPLETION" to now.minusMinutes(10), "COMPLAINT" to now.minusMinutes(5), "BEFORE" to null)
        assertEquals(2, roundCount(media, "BEFORE", start))   // the one with no time recorded counts, as on the web
        assertEquals(1, roundCount(media, "COMPLETION", start))
        assertEquals(3, roundCount(media, "BEFORE", null))
    }

    @Test fun escalationLevelSaysAlertedDueNowOrWhenAsTheWebDoes() {
        assertEquals("Alerted 09 Oct 2026, 8:00 AM", escalationLine(true, now.minusHours(2), now.minusHours(3), now))
        assertEquals("Due now — time passed 09 Oct 2026, 9:00 AM", escalationLine(false, null, now.minusHours(1), now))
        assertEquals("If not fixed by 10 Oct 2026, 10:00 AM", escalationLine(false, null, now.plusDays(1), now))
        assertEquals("Timed once the complaint is checked", escalationLine(false, null, null, now))
    }

    @Test fun standingSaysWhoHoldsTheJobAndSinceWhen() {
        val m = Moments(assigned = now.minusHours(3), claimed = now.minusMinutes(20))
        assertEquals("With R. Yadav (M/s Verma) since 3 h ago. Work not started yet.",
            standing("ASSIGNED", m, "R. Yadav", "M/s Verma", null, now))
        assertEquals("With the contractor since 3 h ago. Work not started yet.", standing("ASSIGNED", m, null, null, null, now))
        assertEquals("R. Yadav (M/s Verma) says the work is done (20 min ago). Waiting for your inspection on site.",
            standing("WORK_COMPLETED", m, "R. Yadav", "M/s Verma", null, now))
    }
}
