"""Hushabye tests: unit tests plus end-to-end runs in headless Chrome.

Chrome is started with a fake microphone that plays a WAV file, so the whole
chain (microphone -> detector -> state machine -> sound engine) is exercised
without a baby.

    pip install playwright
    python tests/run_tests.py              # everything
    python tests/run_tests.py --fetch-cry  # first download real cry clips
    python tests/run_tests.py -k shadow    # only scenarios whose name matches

Uses the Chrome already installed on this machine (no browser download).
"""

import argparse
import array
import csv
import functools
import http.server
import io
import math
import random
import sys
import threading
import urllib.request
import wave
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "tests" / "audio"
SR = 48000
ESC50 = "https://raw.githubusercontent.com/karolpiczak/ESC-50/master/"

MIME = {
    ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json",
    ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
    ".png": "image/png", ".wav": "audio/wav", ".tflite": "application/octet-stream",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        return MIME.get(Path(path).suffix.lower(), "application/octet-stream")

    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(Handler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


# ------------------------------------------------------------ test audio

def write_wav(path, samples):
    data = array.array("h", (int(max(-1.0, min(1.0, s)) * 32767) for s in samples))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def quiet(seconds=10):
    rnd = random.Random(1)
    return [rnd.uniform(-1, 1) * 0.002 for _ in range(SR * seconds)]


def synthetic_cry(seconds=10):
    """Harmonic 450 Hz voice with vibrato, in 0.8 s bursts: cry-like for the heuristic."""
    rnd = random.Random(2)
    out, phase = [], 0.0
    for i in range(SR * seconds):
        t = i / SR
        f = 450 * (1 + 0.04 * math.sin(2 * math.pi * 6 * t))
        phase += 2 * math.pi * f / SR
        u = t % 1
        burst = min(1, u / 0.05, (0.8 - u) / 0.05) if u < 0.8 else 0
        v = sum(math.sin(h * phase) / h for h in range(1, 7))
        out.append(v * 0.25 * burst + rnd.uniform(-1, 1) * 0.002)
    return out


def own_sound(seconds=10):
    """Roughly what the app plays at its loudest: deep rumble plus some hiss."""
    rnd = random.Random(3)
    out, y, lp = [], 0.0, 0.0
    for i in range(SR * seconds):
        w = rnd.uniform(-1, 1)
        y = 0.995 * y + w * 0.1
        lp += 0.06 * (y - lp)
        pulse = 0.75 + 0.25 * math.sin(2 * math.pi * 1.25 * i / SR)
        out.append((lp * 0.5 + w * 0.03) * pulse)
    return out


def make_audio():
    AUDIO.mkdir(parents=True, exist_ok=True)
    for name, fn in (("quiet.wav", quiet), ("cry_synth.wav", synthetic_cry), ("own_sound.wav", own_sound)):
        if not (AUDIO / name).exists():
            write_wav(AUDIO / name, fn())


def fetch_real_cry():
    """Download a few 'crying baby' clips from the ESC-50 dataset (CC BY-NC).

    They are for local testing only and are not part of the repository.
    """
    AUDIO.mkdir(parents=True, exist_ok=True)
    meta = urllib.request.urlopen(ESC50 + "meta/esc50.csv", timeout=60).read().decode()
    names = [r["filename"] for r in csv.DictReader(io.StringIO(meta)) if r["category"] == "crying_baby"][:4]
    frames, params = [], None
    for name in names:
        raw = urllib.request.urlopen(ESC50 + "audio/" + name, timeout=60).read()
        with wave.open(io.BytesIO(raw)) as w:
            params = w.getparams()
            frames.append(w.readframes(w.getnframes()))
    with wave.open(str(AUDIO / "cry_real.wav"), "wb") as w:
        w.setparams(params)
        w.writeframes(b"".join(frames))
    print(f"Saved {len(names)} clips to {AUDIO / 'cry_real.wav'}")


# -------------------------------------------------------------- scenarios

class Failure(Exception):
    pass


def check(cond, message):
    if not cond:
        raise Failure(message)


def hush(page, expr):
    return page.evaluate(f"(() => {{ const h = window.__hush; return {expr}; }})()")


def open_app(page, base, query="", shadow=False, fast=False):
    page.goto(f"{base}/index.html{query}")
    for _ in range(5):  # walk through the setup guide
        page.click("#setupNext")
    page.wait_for_selector("#setup", state="hidden")
    hush(page, f"h.applySetting('shadowMode', {str(shadow).lower()})")
    hush(page, f"h.applySetting('fastTest', {str(fast).lower()})")


def start(page, wait_model=False):
    page.click("#startStop")
    page.wait_for_function("window.__hush.machine.mode === 'running'", timeout=20000)
    page.evaluate(
        """() => {
            window.__scores = [];
            const d = window.__hush.detector;
            if (d) d.addEventListener('window', (e) => window.__scores.push(e.detail));
        }"""
    )
    if wait_model:
        page.wait_for_function("window.__hush.detector && window.__hush.detector.engine === 'yamnet'", timeout=60000)


def scores(page):
    return page.evaluate("window.__scores.map((s) => s.score)")


def t_unit(page, base):
    page.goto(f"{base}/tests/unit.html")
    page.wait_for_function("window.__results", timeout=30000)
    r = page.evaluate("window.__results")
    for f in r["failures"]:
        print(f"      unit: {f['name']}: {f['error']}")
    check(not r["failures"], f"{len(r['failures'])} of {r['total']} unit tests failed")
    return f"{r['passed']} unit tests"


def t_model_real_cry(page, base):
    open_app(page, base)
    start(page, wait_model=True)
    page.wait_for_function("window.__hush.machine.level >= 1", timeout=30000)
    check("Crying detected" in page.inner_text("#log"), "log does not mention crying")
    s = scores(page)
    return f"YAMNet cry scores up to {max(s):.2f}"


def t_model_quiet(page, base):
    open_app(page, base)
    start(page, wait_model=True)
    page.wait_for_timeout(12000)
    s = scores(page)
    check(len(s) >= 8, f"only {len(s)} windows in 12 s")
    check(hush(page, "h.machine.level") == 0, "escalated in a quiet room")
    check(max(s) < 0.1, f"quiet room scored {max(s):.2f}")
    return f"{len(s)} windows, top score {max(s):.2f}"


def t_model_own_sound(page, base):
    open_app(page, base)
    start(page, wait_model=True)
    page.wait_for_timeout(12000)
    s = scores(page)
    check(hush(page, "h.machine.level") == 0, "the app's own sound triggered escalation")
    check(max(s) < 0.12, f"own sound scored {max(s):.2f}")
    return f"top score {max(s):.2f}"


def t_basic_synth_cry(page, base):
    open_app(page, base, "?model=off")
    start(page)
    page.wait_for_function("window.__hush.machine.level >= 1", timeout=30000)
    check(hush(page, "h.detector.engine") == "heuristic", "not using the basic detector")
    return f"basic detector scores up to {max(scores(page)):.2f}"


def t_basic_own_sound(page, base):
    open_app(page, base, "?model=off")
    start(page)
    page.wait_for_timeout(12000)
    s = scores(page)
    check(hush(page, "h.machine.level") == 0, "the app's own sound triggered the basic detector")
    return f"top score {max(s):.2f}"


PEAK_JS = """async () => {
    const e = window.__hush.engine;
    const buf = new Float32Array(e.outAnalyser.fftSize);
    let peak = 0;
    for (let i = 0; i < 40; i++) {
        e.outAnalyser.getFloatTimeDomainData(buf);
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
        await new Promise((r) => setTimeout(r, 50));
    }
    return peak;
}"""


def t_escalation_and_cap(page, base):
    open_app(page, base, "?model=off", fast=True)
    hush(page, "h.applySetting('sound.cap', 60)")
    start(page)
    page.click("#simBtn")
    page.wait_for_function("window.__hush.machine.level === 4", timeout=90000)
    check(hush(page, "h.engine.level") == 4, "engine did not follow to level 4")
    page.wait_for_timeout(2500)  # let the gain ramp finish

    cap_gain = 10 ** ((60 - 100) / 2 / 20)
    peak = page.evaluate(PEAK_JS)
    check(0 < peak <= cap_gain * 1.001, f"level 4 peak {peak:.4f} is above the cap {cap_gain:.4f}")
    # Push a full-scale tone into the mix: the cap must still hold.
    page.evaluate(
        """() => {
            const e = window.__hush.engine;
            const osc = e.ctx.createOscillator();
            const g = e.ctx.createGain();
            g.gain.value = 8;
            osc.frequency.value = 300;
            osc.connect(g); g.connect(e.mix); osc.start();
            window.__osc = osc;
        }"""
    )
    page.wait_for_timeout(500)
    loud = page.evaluate(PEAK_JS)
    page.evaluate("window.__osc.stop()")
    check(loud <= cap_gain * 1.001, f"overdriven peak {loud:.4f} is above the cap {cap_gain:.4f}")
    check(loud > cap_gain * 0.5, "the overdrive test tone did not reach the output")

    page.wait_for_selector("#needsYou", state="visible", timeout=120000)
    check(hush(page, "h.machine.mode") == "needsYou", "not in the needs-you state")
    check(hush(page, "h.engine.level") == 0, "sound did not return to baseline")
    page.click("#needsResume")
    page.click("#simBtn")  # stop the simulated cry
    check(hush(page, "h.machine.mode") == "running", "did not resume")

    page.click("#simBtn")
    page.wait_for_function("window.__hush.machine.level >= 2", timeout=60000)
    page.click("#simBtn")
    page.wait_for_function("window.__hush.machine.level === 0", timeout=90000)
    check("Settled" in page.inner_text("#log"), "log does not show settling")
    return f"peak {peak:.4f}, overdriven {loud:.4f}, cap {cap_gain:.4f}"


def t_shadow_mode(page, base):
    open_app(page, base, "?model=off", shadow=True, fast=True)
    start(page)
    page.click("#simBtn")
    page.wait_for_function("window.__hush.machine.level >= 2", timeout=60000)
    check(hush(page, "h.engine.level") == 0, "shadow mode raised the volume")
    check("would go up" in page.inner_text("#log"), "shadow log entry missing")
    page.wait_for_function("window.__hush.machine.mode === 'needsYou'", timeout=120000)
    check(not page.is_visible("#needsYou"), "shadow mode showed the needs-you screen")
    return "volume stayed at baseline"


def t_pause(page, base):
    open_app(page, base, "?model=off", fast=True)
    start(page)
    page.click("#simBtn")
    page.wait_for_function("window.__hush.machine.level >= 1", timeout=30000)
    page.click("#pauseBtn")
    check(hush(page, "h.machine.mode") == "paused", "not paused")
    page.wait_for_timeout(4000)
    check(hush(page, "h.engine.level") == 0, "crying raised the volume during a pause")
    page.click("#pauseBtn")
    check(hush(page, "h.machine.mode") == "running", "did not resume")
    return "crying ignored while paused"


def t_sound_out_and_export(page, base):
    """Defaults are audible, the meter shows it, and the export carries the details."""
    open_app(page, base, shadow=True)
    check(hush(page, "h.settings.sound.cap") == 75, "default cap is not 75")
    start(page)
    page.wait_for_timeout(5000)
    out_db = hush(page, "h.engine.outputDb()")
    check(-50 < out_db < -25, f"baseline output is {out_db:.0f} dB, expected about -40")
    width = page.evaluate("parseFloat(document.getElementById('outBar').style.width)")
    check(width > 30, f"sound-out meter shows {width}%")
    page.click("#startStop")
    page.wait_for_function("window.__hush.machine.mode === 'idle'")
    page.click("#settingsBtn")
    with page.expect_download() as dl:
        page.click("#settingsForm button:text-is('Export night log')")
    import json
    data = json.loads(Path(dl.value.path()).read_text(encoding="utf-8"))
    diag = [e for e in data["events"] if e.get("kind") == "diag"]
    check(diag and diag[-1]["data"]["sampleRate"] > 0, "no diagnostics record in the export")
    check(data["settings"]["sound"]["cap"] == 75, "settings missing from the export")
    batch = data["scores"][-1]
    check(len(batch["mic"]) == len(batch["scores"]) == len(batch["out"]), "mic and output levels missing from the export")
    return f"baseline leaves the app at {out_db:.0f} dB; export has settings, diagnostics and levels"


def t_old_defaults_migrate(page, base):
    """Settings saved by version 1 with the inaudible defaults are moved up; changed ones are kept."""
    page.goto(f"{base}/tests/unit.html")
    page.evaluate(
        """() => localStorage.setItem('hushabye.settings.v1', JSON.stringify({
            setupDone: true, echoCancellation: true, shadowMode: true,
            sound: { cap: 40, baselineDb: -20, bpm: 70 },
        }))"""
    )
    page.goto(f"{base}/index.html")
    check(hush(page, "h.settings.sound.cap") == 75, "old default cap was not raised")
    check(hush(page, "h.settings.sound.baselineDb") == -20, "a baseline the user chose was overwritten")
    check(hush(page, "h.settings.sound.bpm") == 70, "other settings were lost")
    check(hush(page, "h.settings.echoCancellation") is False, "echo cancellation was not switched off")
    check(hush(page, "h.settings.setupDone") is True, "setup would have to be redone")
    return "old quiet defaults raised, chosen values kept"


def t_no_microphone(page, base):
    open_app(page, base)
    page.click("#startStop")
    page.wait_for_selector("#banner", state="visible", timeout=20000)
    check(hush(page, "h.engine.running"), "sound is not playing without a microphone")
    check(hush(page, "h.machine.mode") == "running", "not running")
    check(page.inner_text("#bannerAction") == "Try again", "no retry button")
    check("Allow" in page.inner_text("#bannerText"), "banner does not say how to allow the microphone")
    return "baseline plays, banner explains and offers a retry"


def t_setup_mic_step(page, base):
    page.goto(f"{base}/index.html")
    page.click("#setupNext")
    page.click("#setupNext")
    page.wait_for_selector("#micAllow", state="visible")
    page.wait_for_function("document.getElementById('micStatus').textContent.length > 0")
    if page.is_enabled("#micAllow"):  # already allowed in this browser: nothing to tap
        page.click("#micAllow")
    page.wait_for_function("document.getElementById('micStatus').textContent.includes('allowed')", timeout=15000)
    check(page.is_disabled("#micAllow"), "button still active after allowing")
    return "setup step requests and confirms the microphone"


def t_setup_mic_blocked(page, base):
    page.goto(f"{base}/index.html")
    page.click("#setupNext")
    page.click("#setupNext")
    page.click("#micAllow")
    page.wait_for_function("document.getElementById('micStatus').textContent.includes('Settings')", timeout=15000)
    diag = page.inner_text("#micDiag")
    check("NotAllowedError" in diag and "permission state" in diag, "no diagnostics after a failure: " + diag[:80])
    check(page.is_visible("#micCopy"), "no copy button for the diagnostics")
    page.click("#setupNext")  # setup can still be finished without a microphone
    page.wait_for_selector("#calibCap", state="visible")
    return "blocked microphone gets instructions"


def t_in_app_browser(page, base):
    """A phone opening the page inside another app's WebView gets a way out."""
    ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36"
    ctx = page.context.browser.new_context(user_agent=ua, viewport={"width": 412, "height": 915})
    p2 = ctx.new_page()
    p2.goto(f"{base}/index.html")
    p2.click("#setupNext")
    p2.click("#setupNext")
    p2.wait_for_selector("#openChrome", state="visible")
    href = p2.get_attribute("#openChrome", "href")
    check(href.startswith("intent://") and "package=com.android.chrome" in href, "bad Chrome link: " + href)
    check("another app" in p2.inner_text("#micStatus"), "in-app browser not explained")
    ctx.close()
    return "in-app browser is explained, with an Open in Chrome link"


def t_music_and_filter(page, base):
    open_app(page, base)
    page.click("#settingsBtn")
    page.set_input_files("#settingsForm input[type=file]", str(AUDIO / "cry_synth.wav"))
    page.wait_for_selector("#trackList li button")
    check(hush(page, "h.settings.tracksEnabled"), "choosing a file did not enable music")
    page.click("#settingsForm button:text-is('Deep')")
    check(hush(page, "h.settings.sound.womb.slope") == 24, "preset not applied")
    page.click("#previewToggle")
    page.wait_for_function("window.__hush.engine.trackEl && window.__hush.engine.trackEl.currentTime > 0.5", timeout=20000)
    level = page.evaluate(
        """async () => {
            const e = window.__hush.engine;
            const buf = new Float32Array(e.trackAnalyser.fftSize);
            let sum = 0;
            for (let i = 0; i < 20; i++) {
                e.trackAnalyser.getFloatTimeDomainData(buf);
                for (const v of buf) sum += v * v;
                await new Promise((r) => setTimeout(r, 50));
            }
            return Math.sqrt(sum / (20 * buf.length));
        }"""
    )
    check(level > 0.001, "no music signal after the womb filter")
    page.click("#settingsClose")
    check(not hush(page, "h.engine.running"), "preview kept playing after closing settings")
    return f"filtered music level {level:.3f}"


def t_phone_test_page(page, base):
    page.goto(f"{base}/phone-test.html")
    page.click("#go")
    page.wait_for_function("document.getElementById('phase').textContent.includes('Sound only')", timeout=5000)
    page.wait_for_function("document.getElementById('phase').textContent.includes('Microphone is ON')", timeout=20000)
    page.wait_for_timeout(5000)
    page.click("#effect button[data-effect='no change']")
    report = page.evaluate("JSON.parse(document.getElementById('report').textContent)")
    check(report["live"]["windows"] >= 2, "phone test received no microphone audio")
    check(report["saved"]["micEffect"]["off"] == "no change", "answer to the first check was not saved")
    check(0.9 < report["live"]["windowsPerSecond"] < 1.1, f"audio clock off: {report['live']['windowsPerSecond']}")
    page.click("#go")
    page.wait_for_function("document.getElementById('go').textContent === 'Start test'")
    return f"{report['live']['windows']} windows received"


SCENARIOS = [
    ("unit", t_unit, "quiet.wav", True),
    ("model_real_cry", t_model_real_cry, "cry_real.wav", True),
    ("model_quiet", t_model_quiet, "quiet.wav", True),
    ("model_own_sound", t_model_own_sound, "own_sound.wav", True),
    ("basic_synth_cry", t_basic_synth_cry, "cry_synth.wav", True),
    ("basic_own_sound", t_basic_own_sound, "own_sound.wav", True),
    ("escalation_and_cap", t_escalation_and_cap, "quiet.wav", True),
    ("shadow_mode", t_shadow_mode, "quiet.wav", True),
    ("pause", t_pause, "quiet.wav", True),
    ("sound_out_and_export", t_sound_out_and_export, "quiet.wav", True),
    ("old_defaults_migrate", t_old_defaults_migrate, "quiet.wav", True),
    ("no_microphone", t_no_microphone, None, False),
    ("setup_mic_step", t_setup_mic_step, "quiet.wav", True),
    ("setup_mic_blocked", t_setup_mic_blocked, None, False),
    ("in_app_browser", t_in_app_browser, None, False),
    ("music_and_filter", t_music_and_filter, "quiet.wav", True),
    ("phone_test_page", t_phone_test_page, "quiet.wav", True),
]


def run(pw, base, name, fn, wav, mic, headed):
    args = ["--autoplay-policy=no-user-gesture-required"]
    if mic:
        args += [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-audio-capture={AUDIO / wav}",
        ]
    else:
        args += ["--deny-permission-prompts"]
    browser = pw.chromium.launch(channel="chrome", headless=not headed, args=args)
    errors = []
    try:
        context = browser.new_context(viewport={"width": 412, "height": 915})
        if mic:
            context.grant_permissions(["microphone"])
        page = context.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        detail = fn(page, base)
        check(not errors, "page errors: " + "; ".join(errors))
        return True, detail
    except Exception as exc:  # noqa: BLE001 - report every failure the same way
        return False, f"{type(exc).__name__}: {str(exc)[:900]}" + (f" | page errors: {errors}" if errors else "")
    finally:
        browser.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-k", default="", help="only run scenarios whose name contains this")
    parser.add_argument("--fetch-cry", action="store_true", help="download real cry clips for the YAMNet test")
    parser.add_argument("--headed", action="store_true", help="show the browser")
    opts = parser.parse_args()

    if opts.fetch_cry:
        fetch_real_cry()
    make_audio()
    server, base = serve()
    failed = 0
    with sync_playwright() as pw:
        for name, fn, wav, mic in SCENARIOS:
            if opts.k and opts.k not in name:
                continue
            if wav and not (AUDIO / wav).exists():
                print(f"SKIP  {name}: {wav} missing (run with --fetch-cry)")
                continue
            ok, detail = run(pw, base, name, fn, wav, mic, opts.headed)
            print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}", flush=True)
            failed += 0 if ok else 1
    server.shutdown()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
