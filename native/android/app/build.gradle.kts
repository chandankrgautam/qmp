plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
}

/*
 * The API client is generated from the portal's own specification
 * (the two YAML files in spec/ at the repository root) on every build, so the app cannot
 * drift from the server's contract: a change to the spec changes the app's
 * types, and an invalid spec fails the build (the generator validates it).
 * The generator runs as a plain Java task: its Gradle plugin does not work
 * with Android Gradle Plugin 9.
 */
val openapiCli: Configuration by configurations.creating
val specDir = rootProject.projectDir.resolve("../../spec")
val generated = layout.buildDirectory.dir("generated/openapi")
fun portalClient(name: String) = tasks.registering(JavaExec::class) {
  val spec = specDir.resolve("$name-api.yaml")
  val out = generated.map { it.dir(name) }
  inputs.file(spec)
  outputs.dir(out)
  classpath = openapiCli
  mainClass.set("org.openapitools.codegen.OpenAPIGenerator")
  argumentProviders.add(CommandLineArgumentProvider { listOf(
    "generate", "-i", spec.absolutePath, "-g", "kotlin", "-o", out.get().asFile.absolutePath,
    "--package-name", "in.ncl.civilportal.api.$name",
    "--additional-properties", "library=jvm-retrofit2,serializationLibrary=kotlinx_serialization,useCoroutines=true,omitGradleWrapper=true",
    "--global-property", "apiTests=false,modelTests=false,apiDocs=false,modelDocs=false") })
  // `in` is a Kotlin keyword and the generator does not escape it in the
  // package and import lines it writes
  doLast {
    out.get().asFile.walk().filter { it.extension == "kt" }.forEach { f ->
      val text = f.readText()
      val fixed = text.replace(Regex("^(package|import) in[.]", RegexOption.MULTILINE), "$1 `in`.")
      if (fixed != text) f.writeText(fixed)
    }
  }
}
val generateIdentityClient by portalClient("identity")
val generateMaintenanceClient by portalClient("maintenance")

android {
    namespace = "in.ncl.civilportal"
    compileSdk = 36
    defaultConfig {
        applicationId = "in.ncl.civilportal"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        // The portal's address. In development the phone reaches this PC over
        // USB with `adb reverse tcp:3000 tcp:3000`, so localhost is the PC.
        buildConfigField("String", "DEFAULT_SERVER", "\"http://127.0.0.1:3000\"")
        manifestPlaceholders["appLabel"] = "NCL Colony Maintenance"
    }

    /* Test phones on one handset (user's request, 2026-10-13). The portal
       checks people, not roles: the inspector may never be the person who did
       the work, so one phone switching roles cannot carry a complaint through.
       "two" and "three" install beside the real app under their own package,
       so each has its own Keystore key and data and registers as a separate
       phone, for a separate person, approved like any other. Debug only: the
       release build is the one app. */
    flavorDimensions += "phone"
    productFlavors {
        create("one") { dimension = "phone" }
        create("two") {
            dimension = "phone"
            applicationIdSuffix = ".test2"
            manifestPlaceholders["appLabel"] = "Portal 2 (test)"
        }
        create("three") {
            dimension = "phone"
            applicationIdSuffix = ".test3"
            manifestPlaceholders["appLabel"] = "Portal 3 (test)"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "DEFAULT_SERVER", "\"https://portal.example.invalid\"")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
      compose = true
      aidl = false
      buildConfig = true
      shaders = false
    }

    packaging {
      resources {
        excludes += "/META-INF/{AL2.0,LGPL2.1}"
      }
    }
}

androidComponents.beforeVariants { v ->
  if (v.buildType == "release" && v.productFlavors.any { it.second != "one" }) v.enable = false
}

// the generated clients are part of the app's sources (preBuild runs the
// generators first)
androidComponents.onVariants { variant ->
  listOf("identity", "maintenance").forEach {
    variant.sources.kotlin?.addStaticSourceDirectory(generated.get().dir("$it/src/main/kotlin").asFile.path)
  }
}
tasks.named("preBuild") { dependsOn(generateIdentityClient, generateMaintenanceClient) }

dependencies {
  openapiCli(libs.openapi.generator.cli)

  val composeBom = platform(libs.androidx.compose.bom)
  implementation(composeBom)

  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.fragment.ktx)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  implementation(libs.androidx.compose.material.icons)
  debugImplementation(libs.androidx.compose.ui.tooling)

  // the PIN / fingerprint unlock for official roles (decision 15)
  implementation(libs.androidx.biometric)

  // photographs are taken in the app, never picked from the gallery (control 2)
  implementation(libs.camerax.core)
  implementation(libs.camerax.camera2)
  implementation(libs.camerax.lifecycle)
  implementation(libs.camerax.view)

  // what the generated client needs
  implementation(libs.retrofit)
  implementation(libs.retrofit.converter.kotlinx)
  implementation(libs.retrofit.converter.scalars)
  implementation(libs.okhttp)
  implementation(libs.okhttp.logging)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.kotlinx.coroutines.android)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
}
