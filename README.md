# Hushabye

A web app that runs on a phone next to a newborn's bassinet. It plays a quiet, womb-like sound all night through a Bluetooth speaker, listens for crying, raises the sound step by step while the crying continues, and steps back down when the baby settles. If soothing does not work it returns to the quiet baseline and shows "Baby needs you".

It is one static site with no backend. All audio is processed on the phone; nothing is recorded or uploaded.

## Safety first

- **Safe sleep:** always on the back, on a flat, firm surface, with nothing loose in the bassinet.
- **Volume:** aim for 50 dBA or less where the baby's head is. The app has a volume cap that no level, music or voice can exceed; you set it once with a sound-meter app (see setup below).
- **Speaker:** at least 2 m from the baby, never in or on the bassinet.
- **Phone:** out of the baby's reach, charging cable well away, never in the bassinet. Nothing is attached to the bassinet.
- **Not a monitor:** this is a soother. It cannot tell why a baby is crying and does not replace a parent in the room.

## Setting up the phone and speaker

1. Open the site in Chrome on the Android phone, by typing the address into Chrome itself. A link tapped inside another app often opens in that app's built-in browser, which cannot use the microphone. It must be served over HTTPS (GitHub Pages is fine), or the microphone will not work. Optionally use Chrome's menu, "Add to Home screen".
2. Load the page once while online. After that it works offline, so the phone can be in airplane mode with Bluetooth on.
3. Turn on **Do Not Disturb**, or calls and notifications will play through the speaker.
4. Connect the JBL speaker, plug both phone and speaker into power, and put the speaker at least 2 m from the bassinet.
5. Set the phone's media volume and the speaker's volume where you will leave them.
6. Open **Phone test** (link at the bottom of the app) and run its three checks. They tell you:
   - whether this phone keeps listening with the screen off (if not, leave the screen on and use **Night screen**, which is pure black);
   - whether the browser notices the speaker disconnecting (needed for auto-mute);
   - whether switching the microphone on changes, moves or silences the sound (the first check);
   - whether echo cancellation helps or gets in the way. It is off by default, because on some phones it reroutes playback.
7. Go through the **Setup guide** in the app. It has an **Allow microphone** button; choose Allow when Chrome asks. If Chrome never asks, check two places. In the phone's Settings: Apps, Chrome, Permissions, Microphone must be "Allow only while using the app" (with "Ask every time", Chrome never asks). In Chrome: menu, Settings, Site settings, Microphone, then allow the site. The volume step plays the loudest level so you can move the cap until a sound meter at the baby's position reads 45 to 50 dBA, never more. If you hear nothing, or cannot reach 45 with the cap at 100%, turn up the phone's media volume or the speaker and set the cap again. Phone meters are approximate, and deep rumble reads lower in dBA than it really is.
8. Press **Start**. Turn the phone's screen brightness to minimum and tap **Night screen**.
9. **Leave Hushabye on screen all night.** Do not press the power button or switch apps. On the phone this was built for (Android 10), Chrome silences the microphone within seconds of the screen going off and closes the page a few minutes later. The app reconnects the microphone when it is back on screen and tells you how long it was not listening.

**First nights:** shadow mode is on by default. The app plays the baseline, listens, and logs what it would have done, without raising the volume. Compare the log with what really happened, then turn shadow mode off in Settings.

**If you change the phone or speaker volume, redo the cap.** The app cannot see those controls.

## What it does

| | |
|---|---|
| Baseline | Deep brown-noise rumble with a slow heartbeat "whoosh" (75 beats per minute by default). Plays all night, which also stops the speaker from switching itself off. |
| Levels 1 to 4 | Each level is louder and adds a little more mid-range "shush". Changes are smooth ramps. Level 4 is exactly the volume cap. |
| Crying | When at least 3 of the last 5 seconds contain crying: one level up, then one more every 25 seconds while it continues. |
| Quiet | One level down per 60 seconds of quiet, back to baseline. |
| Give up | After 2.5 minutes of crying at Level 4: back to baseline, "Baby needs you" on screen. It starts responding again after 5 minutes of quiet, or when you tap. |
| Pause | "Pause 20 min" ignores crying during a feed or change. |
| Test | "Simulate crying" drives the escalation without a baby. "Fast test clock" in Settings runs the timings about ten times faster. |

All timings are in Settings.

### Cry detection

The microphone is cut into one-second windows. Each is scored by the YAMNet audio classifier (MediaPipe Tasks, running on the phone in WebAssembly), using its "Baby cry, infant cry" class plus a little weight from "Crying, sobbing" and "Whimper". While the model loads, or if it cannot load, a simpler detector takes over: sound clearly above the room's noise floor, with a strong steady pitch in the infant range (250 to 650 Hz) that is not a harmonic of a lower adult voice.

### Womb filter (for your own audio files and for mom's voice)

Choose audio files in Settings and they loop softly under the rumble, filtered to sound roughly as they would from inside the uterus. A recorded voice clip goes through the same filter.

What published measurements say:

- Below about 250 to 300 Hz, sound reaches the fetus almost unchanged. Above that, attenuation grows by roughly 5 to 6 dB per octave ([Abrams et al. 1998](https://acnpsearch.tweb-dev.unibo.it/singlejournalindex/59445455); [Gerhardt and Abrams, ASA 1997](https://www.auditory.org/asamtgs/asa97snd/2pNSb/2pNSb1.html)).
- The measurements disagree on how much. Human recordings found external voices only 2 to 3 dB quieter and the mother's own voice about 5 dB louder inside ([Sound levels in the human uterus, 1992](https://pesquisa.bvsalud.org/portal/resource/pt/mdl-1635729)), and a newer sheep study found high frequencies getting through as well ([Jauniaux et al.](https://discovery.ucl.ac.uk/id/eprint/10075679/)). Fetal inner-ear measurements, on the other hand, show 40 dB or more of loss above 500 Hz ([Gerhardt and Abrams, ASA 1996](https://auditory.org/asamtgs/asa96haw/3pAB/3pAB12.html)). So the slope is a setting.
- Melody, rhythm and intonation survive; consonants mostly do not.
- The background is the mother's heartbeat and blood flow, plus irregular low sounds from digestion ([womb sound recordings, PLoS ONE 2018](https://pmc.ncbi.nlm.nih.gov/articles/PMC5944959)).

The filter, in order:

1. Sum to mono.
2. High-pass at 60 Hz (a small speaker cannot play lower; it only wastes headroom).
3. Optional low shelf, +3 dB below 250 Hz ("body warmth").
4. Low-pass from an adjustable frequency, at 6, 12 or 24 dB per octave. The default, 300 Hz at 6 dB per octave, follows the classic measurements. Steeper settings sound more "underwater".
5. Compressor and slow automatic levelling, so quiet and loud recordings end up similar and nothing startles.
6. A light heartbeat pulse in time with the rumble.

Presets: **Research-like**, **Muffled**, **Deep**. "Compare: filter off" lets you hear the difference. The filter runs live, so files of any length work.

The premature-baby studies that inspired this played recordings of the mother's voice and heartbeat with the high frequencies removed ([Webb et al., PNAS 2015](https://pmc.ncbi.nlm.nih.gov/articles/PMC4364233)).

### The volume cap

Everything is mixed, passed through a limiter and a hard clipper, and only then multiplied by the cap. Levels, music and voice together cannot exceed it. Every 2 points on the cap slider is 1 dB. The 50 dBA target is the limit hospital nurseries use; a 2014 study found that most infant sound machines exceed it at full volume ([Hugh et al., Pediatrics 2014](https://doi.org/10.1542/peds.2013-3617)).

With a cap this low, expect a gentler effect than a commercial responsive bassinet, which goes much louder at its top levels.

### Things that protect the night

- **Speaker disconnects:** if the browser reports a change in audio outputs, the sound is muted and a banner asks you to check. Otherwise a dropped Bluetooth link would move the sound to the phone, right beside the baby. Whether Chrome reports this depends on the phone: check with Phone test B.
- **Audio interrupted** (a call, another app): the app tries to resume and writes it in the log.
- **Screen:** a wake lock keeps the screen on; it is re-acquired when you come back to the page.
- **Sound out meter:** shows what the app is sending to the speaker. If it moves and you hear nothing, the problem is between the phone and the speaker.
- **Log:** events, and per second the cry score, room level and output level, are kept for 7 nights on the phone and can be exported from Settings together with the settings and audio details. No audio is stored.

## Publishing on GitHub Pages

The folder is the site; there is no build step.

1. Push it to a GitHub repository.
2. In the repository: Settings, Pages, "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Open `https://<user>.github.io/<repo>/` on the phone.

After changing files, bump `VERSION` in `sw.js` and `APP_VERSION` in `js/app.js`. Phones then pick up the new version on the next reload; the version number is shown at the bottom of the app.

## Tests

```
pip install playwright
python tests/run_tests.py --fetch-cry
```

This uses the Chrome installed on the machine, started with a fake microphone that plays a WAV file. It runs:

- 30 unit tests (escalation state machine with simulated detections, womb filter response, level and cap maths, the basic cry detector) - also viewable at `tests/unit.html`;
- end-to-end checks: real cry recordings raise the level through YAMNet; a quiet room and the app's own sound do not; the basic detector works when the model is disabled; a full simulated escalation up to "Baby needs you" and back down; the cap holds even with a full-scale tone forced into the mix; shadow mode never raises the volume; pause ignores crying; the app still plays without a microphone; music upload and the womb filter; the phone test page.

`--fetch-cry` downloads four "crying baby" clips from the ESC-50 dataset (CC BY-NC) into `tests/audio/`, which is not committed.

**Manual test:** start the app with shadow mode off, play a "baby crying" video from another device near the phone, and watch the level climb.

## Known limits

- Nothing here has been tested on a real phone yet. Screen-off listening, echo cancellation with a Bluetooth speaker, and disconnect detection all vary by phone, which is what the Phone test page is for.
- A web page cannot read or set the phone's or speaker's volume, or the screen brightness.
- The womb filter is an approximation built from published attenuation curves, not a validated simulation.
- No alerts to a parent's phone, and no native app.

## Credits

- [MediaPipe Tasks Audio](https://www.npmjs.com/package/@mediapipe/tasks-audio) 0.10.35 and the YAMNet model, both Apache 2.0, are included under `vendor/` and `models/` so the app works offline.
