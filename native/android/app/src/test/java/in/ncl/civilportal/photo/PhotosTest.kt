package `in`.ncl.civilportal.photo

import org.junit.Assert.assertEquals
import org.junit.Test

/** The portal refuses a photograph whose bytes do not match the fingerprint sent with it. */
class PhotosTest {
    @Test fun fingerprintIsLowercaseHexSha256AsThePortalComputesIt() {
        // the FIPS 180-2 test vector; Node: createHash('sha256').update('abc').digest('hex')
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Photos.sha256("abc".toByteArray()))
        assertEquals(64, Photos.sha256(ByteArray(0)).length)
    }
}
