Pod::Spec.new do |s|
  s.name           = 'ProvianICloudDocuments'
  s.version        = '1.0.0'
  s.summary        = 'iCloud ubiquity-container file store for the encrypted PE backup'
  s.description    = 'Provian native module: coordinated atomic writes, on-demand downloads and a metadata query over <iCloud.com.provian.wallet>/PEBackup/, so the PE meter can keep every PE (already AES-256-GCM ciphertext) in the owner\'s own iCloud.'
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
