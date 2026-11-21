# Store listings

Each locale file has separate Google Play and App Store descriptions. The Google Play sections match the 12 descriptions saved in Play Console.

The App Store sections match the iPhone 1.0.1 build attached to App Review. The English description is saved in App Store Connect. The other descriptions, subtitles, and promotional text are prepared for an editable version. App Store Connect rejected new localizations while the version was submitted, and its metadata language list omits Swahili and Filipino.

Edit `en-US.md` and `localized-copy.json`, then run `npm run generate:store-listings` to refresh the localized Markdown files.
