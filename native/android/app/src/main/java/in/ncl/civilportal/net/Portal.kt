package `in`.ncl.civilportal.net

import `in`.ncl.civilportal.BuildConfig
import `in`.ncl.civilportal.api.identity.apis.AuthApi
import `in`.ncl.civilportal.api.identity.apis.MastersApi
import `in`.ncl.civilportal.api.identity.apis.RegistrationApi
import `in`.ncl.civilportal.api.identity.models.AuthRefreshPostRequest
import `in`.ncl.civilportal.api.maintenance.apis.DisputesApi
import `in`.ncl.civilportal.api.maintenance.apis.InspectionApi
import `in`.ncl.civilportal.api.maintenance.apis.JobCardsApi
import `in`.ncl.civilportal.api.maintenance.apis.LifecycleApi
import `in`.ncl.civilportal.api.maintenance.apis.MaterialsApi
import `in`.ncl.civilportal.api.maintenance.apis.MeasurementBookApi
import `in`.ncl.civilportal.api.maintenance.apis.MediaApi
import `in`.ncl.civilportal.api.maintenance.apis.NoticesApi
import `in`.ncl.civilportal.api.maintenance.apis.NotificationsApi
import `in`.ncl.civilportal.api.maintenance.apis.ObjectionsApi
import `in`.ncl.civilportal.api.maintenance.apis.TicketsApi
import `in`.ncl.civilportal.api.maintenance.apis.MastersApi as MaintMastersApi
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit
import `in`.ncl.civilportal.api.identity.infrastructure.Serializer as IdentityJson
import `in`.ncl.civilportal.api.maintenance.infrastructure.Serializer as MaintenanceJson

/**
 * The connection to the portal: the identity service (sign-in, phones,
 * people) and the maintenance service (complaints), both through clients
 * generated from spec/. Every call carries the access token for the one
 * role in use; when it expires the refresh token renews it once, and a
 * refusal there (role ended, phone revoked) signs the user out.
 */
class Portal(val baseUrl: String, private val session: Session) {
    private val json = "application/json".toMediaType()

    private val bearer = Interceptor { chain ->
        val token = session.accessToken
        val req = if (token != null) chain.request().newBuilder().header("Authorization", "Bearer $token").build()
                  else chain.request()
        chain.proceed(req)
    }

    /* 401 on a signed-in call: renew once with the refresh token, then retry. */
    private val renew = Authenticator { _, response ->
        if (response.request.header("Authorization") == null || response.priorResponse != null) return@Authenticator null
        val refreshed = runBlocking { refresh() }
        if (!refreshed) { session.signedOut(); return@Authenticator null }
        response.request.newBuilder().header("Authorization", "Bearer ${session.accessToken}").build()
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(bearer)
        .authenticator(renew)
        .apply {
            if (BuildConfig.DEBUG) addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
        }
        .build()

    private fun retrofit(path: String, conv: retrofit2.Converter.Factory) = Retrofit.Builder()
        .baseUrl(baseUrl.trimEnd('/') + path)
        .client(http)
        .addConverterFactory(retrofit2.converter.scalars.ScalarsConverterFactory.create())
        .addConverterFactory(conv)
        .build()

    private val identity = retrofit("/identity/v1/", IdentityJson.kotlinxSerializationJson.asConverterFactory(json))
    private val maintenance = retrofit("/maintenance/v1/", MaintenanceJson.kotlinxSerializationJson.asConverterFactory(json))

    val auth: AuthApi = identity.create(AuthApi::class.java)
    val masters: MastersApi = identity.create(MastersApi::class.java)
    val registration: RegistrationApi = identity.create(RegistrationApi::class.java)
    val tickets: TicketsApi = maintenance.create(TicketsApi::class.java)
    val lifecycle: LifecycleApi = maintenance.create(LifecycleApi::class.java)
    val disputes: DisputesApi = maintenance.create(DisputesApi::class.java)
    val objections: ObjectionsApi = maintenance.create(ObjectionsApi::class.java)
    val media: MediaApi = maintenance.create(MediaApi::class.java)
    val catalogue: MaintMastersApi = maintenance.create(MaintMastersApi::class.java)
    val notifications: NotificationsApi = maintenance.create(NotificationsApi::class.java)
    val materials: MaterialsApi = maintenance.create(MaterialsApi::class.java)
    val inspection: InspectionApi = maintenance.create(InspectionApi::class.java)
    val measurements: MeasurementBookApi = maintenance.create(MeasurementBookApi::class.java)
    val notices: NoticesApi = maintenance.create(NoticesApi::class.java)
    val jobCards: JobCardsApi = maintenance.create(JobCardsApi::class.java)

    /* The photograph's bytes go to the signed link the portal hands out:
       relative for the portal's own store, absolute for S3. No bearer token —
       the link is its own authority, and S3 refuses a second one. */
    private val plain = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()

    fun putBytes(link: String, bytes: ByteArray, contentType: String) {
        val url = if (link.startsWith("http")) link else baseUrl.trimEnd('/') + link
        val req = Request.Builder().url(url).put(bytes.toRequestBody(contentType.toMediaType())).build()
        plain.newCall(req).execute().use { if (!it.isSuccessful) throw java.io.IOException("The photograph did not upload (${it.code}). Try again.") }
    }

    suspend fun refresh(): Boolean {
        val rt = session.refreshToken ?: return false
        val r = runCatching { auth.authRefreshPost(AuthRefreshPostRequest(refreshToken = rt)) }.getOrNull() ?: return false
        val body = r.body()
        if (!r.isSuccessful || body?.token == null) return false
        session.signedIn(body)
        return true
    }

    companion object {
        val DEFAULT = BuildConfig.DEFAULT_SERVER
    }
}
