Pod::Spec.new do |s|
  s.name           = 'ProvianStorePurchase'
  s.version        = '1.0.0'
  s.summary        = 'StoreKit 2 bridge for the store builds\' consumable purchases'
  s.description    = 'Provian native module: load products, buy one with the account token attached, list unfinished transactions, and finish one after the relay has recorded it.'
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
