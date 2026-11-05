Pod::Spec.new do |s|
  s.name           = 'ProvianAppAttest'
  s.version        = '1.0.0'
  s.summary        = 'Apple App Attest bridge (Secure Enclave key: attest once, assert per PE)'
  s.description    = 'Provian native module: DCAppAttestService generateKey / attestKey / generateAssertion, so every mobile PE can carry a Secure-Enclave-signed witness over its binding nonce (Trust Layer §2.9).'
  s.author         = 'Provian'
  s.homepage       = 'https://provian.ai'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
