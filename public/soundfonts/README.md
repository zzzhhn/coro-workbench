# Bundled offline soundfonts

Source: paulrosen/midi-js-soundfonts, commit cbd6b6f6d1af89ebfb69402860741288f08ff8b7, FluidR3_GM.

https://github.com/paulrosen/midi-js-soundfonts/tree/cbd6b6f6d1af89ebfb69402860741288f08ff8b7/FluidR3_GM

The piano bank was verified against a local copy of these upstream samples; other banks were downloaded directly from the same upstream commit. The JavaScript object wrappers have been converted to JSON without changing their MP3 data. Playback fetches these files only from the local app, not a public soundfont CDN.

FluidR3_GM samples: Frank Wen and contributors, Creative Commons Attribution 3.0 (https://creativecommons.org/licenses/by/3.0/). Conversion tooling/repository: Benjamin Gleitzman, MIT, see LICENSE.txt. Please retain these credits when distributing the application.

Choir playback is sampled vowel sound, not generated singing, pronunciation, or singer cloning. Percussion is synthesized locally by Web Audio.
