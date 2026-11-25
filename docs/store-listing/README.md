# Store listings

Each locale file has separate Google Play and App Store descriptions. The Google Play sections match the 12 descriptions saved in Play Console.

The App Store sections match the iPhone 1.0.1 build attached to App Review and are saved in App Store Connect in English and nine more languages. App Store Connect's metadata language list omits Swahili and Filipino, so those two files are used on Google Play only.

Edit `en-US.md` and `localized-copy.json`, then run `npm run generate:store-listings` to refresh the localized Markdown files.
