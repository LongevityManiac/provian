Pod::Spec.new do |s|
  s.name           = 'ProvianPinnedTls'
  s.version        = '1.0.0'
  s.summary        = 'Pinned-DNS TLS fetch (connect to validated IP, validate hostname cert)'
  s.description    = 'Provian native module: SSRF-safe HTTPS that pins the resolved IP at the socket while keeping TLS SNI and certificate validation on the hostname. Closes the DNS-rebinding TOCTOU window (review #33).'
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
