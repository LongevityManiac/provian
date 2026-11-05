Pod::Spec.new do |s|
  s.name           = 'ProvianSecureSeed'
  s.version        = '1.0.0'
  s.summary        = 'User-authentication-gated seed storage (keychain .userPresence)'
  s.description    = 'Provian native module: stores the wallet seed behind a user-presence keychain ACL (biometry-any OR device passcode), so re-enrolling Face ID / Touch ID never invalidates it and a passcode-only device can create a wallet.'
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
