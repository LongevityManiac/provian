// ProvianAppAttest (Android) — App Attest is an Apple platform service; there is no equivalent
// bridged here (Play Integrity is a different scheme, not in the §2.9 ruling). Every call reports
// unsupported so the JS side attaches NO witness and the PE goes out at its ordinary class.
package expo.modules.provianappattest

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ProvianAppAttestModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ProvianAppAttest")
    Function("isSupported") { false }
    // Each call is unsupported on Android and throws (fail-closed: Security Invariant #7 —
    // the JS side gates on isSupported()==false and never calls these). The trailing
    // unreachable "" gives each lambda a concrete String return type: Expo's AsyncFunction
    // takes a `reified R`, and a body that only throws infers R = Nothing, which cannot be
    // used as a reified type parameter (Android release Kotlin compile error). String matches
    // the iOS module's return shape; the value is never produced.
    AsyncFunction("generateKey") { _: Any? ->
      throw IllegalStateException("APP_ATTEST_UNSUPPORTED")
      @Suppress("UNREACHABLE_CODE") ""
    }
    AsyncFunction("attestKey") { _: String, _: String ->
      throw IllegalStateException("APP_ATTEST_UNSUPPORTED")
      @Suppress("UNREACHABLE_CODE") ""
    }
    AsyncFunction("generateAssertion") { _: String, _: String ->
      throw IllegalStateException("APP_ATTEST_UNSUPPORTED")
      @Suppress("UNREACHABLE_CODE") ""
    }
  }
}
