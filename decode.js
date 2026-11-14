/* Walmart Scanner barcode reading (Matt, 2026-11-14): live camera + photos.
 *
 * Why this page is no longer inside Google Apps Script: Google serves Apps Script pages in a frame whose
 * "allow" list has no camera, so the live camera could never start there (checked 2026-11-14). This page is a
 * normal top-level page (GitHub Pages), so iPhone Safari and the home-screen app may use the camera.
 *
 * Decoder: zxing-wasm 3.1.6 (the zxing-cpp engine compiled to WebAssembly, vendored in vendor/ - no CDN).
 * It is much stronger than the old JavaScript ZXing / Quagga on blur, glare, low light and turned barcodes.
 * Formats: UPC-A, EAN-13, UPC-E (expanded to UPC-A). Only codes with a valid check digit are returned.
 * Safety against false reads: live camera = the same number in 2 frames; photo = UPC-E needs 2 agreeing reads.
 */
var WMR_DECODE = (function () {
  var FORMATS = ['UPC-A', 'EAN-13', 'UPC-E'];
  var ready = null;
  function prep() {
    if (!ready) {
      ready = ZXingWASM.prepareZXingModule({
        overrides: {locateFile: function (path, prefix) { return path.slice(-5) === '.wasm' ? 'vendor/zxing_reader-3.1.6.wasm' : prefix + path; }},
        fireImmediately: true
      });
      ready.catch(function () { ready = null; });       // a failed download is retried on the next read
    }
    return ready;
  }
  function checkOk(d) {
    if (!/^\d{8}$|^\d{12,14}$/.test(d)) return false;
    var body = d.slice(0, -1), s = 0;
    for (var i = 0; i < body.length; i++) s += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
    return (10 - s % 10) % 10 === Number(d.slice(-1));
  }
  function upcEtoA(e) {
    if (!/^[01]\d{7}$/.test(e)) return null;
    var ns = e[0], d = e.slice(1, 7), c = e[7], last = d[5], m;
    if ('012'.indexOf(last) >= 0) m = d[0] + d[1] + last + '0000' + d[2] + d[3] + d[4];
    else if (last === '3') m = d[0] + d[1] + d[2] + '00000' + d[3] + d[4];
    else if (last === '4') m = d[0] + d[1] + d[2] + d[3] + '00000' + d[4];
    else m = d[0] + d[1] + d[2] + d[3] + d[4] + '0000' + last;
    var a = ns + m + c;
    return checkOk(a) ? a : null;
  }
  /** Any decoded text -> the code to look up (UPC-A / EAN-13), or null if not a valid product code. */
  function clean(text, fmt) {
    var d = String(text || '').replace(/\D/g, '');
    if (d.length === 8 && /UPC.?E/i.test(String(fmt))) return upcEtoA(d);
    return checkOk(d) && [12, 13].indexOf(d.length) >= 0 ? d : null;
  }
  function opts(extra) {
    var o = {formats: FORMATS, tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 1};
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  /** ImageData -> [{code, sure}] (sure = EAN-13 / UPC-A; UPC-E is short and needs a second read). */
  async function read(imgData, extra) {
    await prep();
    var rs = await ZXingWASM.readBarcodes(imgData, opts(extra));
    var out = [];
    (rs || []).forEach(function (r) {
      if (r.isValid === false) return;
      var code = clean(r.text, r.format);
      if (code) out.push({code: code, sure: !/UPC.?E/i.test(String(r.format)), format: r.format});
    });
    return out;
  }
  function loadImg(blob) {
    return new Promise(function (ok, bad) {
      var u = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { ok(img); };          // Safari / Chrome turn the photo upright (EXIF) here
      img.onerror = function () { URL.revokeObjectURL(u); bad(new Error('Could not open the photo')); };
      img.src = u;
    });
  }
  /** Draw (part of) an image or video frame into a canvas no bigger than max px; returns ImageData. */
  function grab(src, W, H, max, band, mode) {
    var sy = band ? H * band[0] : 0, sh = band ? H * (band[1] - band[0]) : H;
    var s = Math.min(1, max / Math.max(W, sh));
    var w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(sh * s));
    var c = grab.c || (grab.c = document.createElement('canvas'));
    c.width = w; c.height = h;
    var g = c.getContext('2d', {willReadFrequently: true});
    g.drawImage(src, 0, sy, W, sh, 0, 0, w, h);
    var d = g.getImageData(0, 0, w, h);
    if (mode === 'stretch') stretch(d);
    return d;
  }
  /** Contrast stretch: helps dim shelves (low light) and washed-out barcodes (glare). */
  function stretch(d) {
    var a = d.data, n = a.length / 4, hist = new Uint32Array(256), L = new Uint8ClampedArray(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) { L[i] = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000; hist[L[i]]++; }
    var lo = 0, hi = 255, acc = 0;
    for (var x = 0; x < 256; x++) { acc += hist[x]; if (acc > n * 0.02) { lo = x; break; } }
    acc = 0;
    for (var y = 255; y >= 0; y--) { acc += hist[y]; if (acc > n * 0.02) { hi = y; break; } }
    var sc = 255 / Math.max(1, hi - lo);
    for (var k = 0, m = 0; k < n; k++, m += 4) { var v = (L[k] - lo) * sc; a[m] = a[m + 1] = a[m + 2] = v; }
  }
  var pause = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  /** A photo (File/Blob) -> {code, how, tries, ms} or {code: null, tries, ms}. */
  async function decode(blob, onStep, limitMs) {
    var t0 = Date.now(), limit = limitMs || 12000, tries = 0, seen = {};
    var vote = function (r, how) {
      seen[r.code] = (seen[r.code] || 0) + 1;
      return r.sure || seen[r.code] >= 2 ? {code: r.code, how: how, tries: tries, ms: Date.now() - t0} : null;
    };
    await prep();
    var img = await loadImg(blob), W = img.naturalWidth, H = img.naturalHeight;
    try {
      // cheapest / most likely first; every step already tries turned, upside-down and inverted barcodes
      var plan = [[2000, null, 'plain', {}], [1200, null, 'plain', {}], [2000, [0.25, 0.75], 'plain', {}],
                  [2000, null, 'stretch', {}], [2000, null, 'plain', {binarizer: 'GlobalHistogram'}],
                  [2000, null, 'plain', {tryDenoise: true}], [3000, null, 'plain', {}], [800, null, 'plain', {}],
                  [2400, [0.5, 1], 'plain', {}], [2400, [0, 0.5], 'plain', {}], [1200, null, 'stretch', {tryDenoise: true}],
                  [2000, [0.25, 0.75], 'stretch', {binarizer: 'GlobalHistogram'}]];
      for (var p = 0; p < plan.length && Date.now() - t0 < limit; p++) {
        tries++;
        var rs = await read(grab(img, W, H, plan[p][0], plan[p][1], plan[p][2]), plan[p][3]);
        for (var i = 0; i < rs.length; i++) { var got = vote(rs[i], 'zxing-cpp step ' + (p + 1)); if (got) return got; }
        if (onStep && p % 3 === 2) onStep('Still reading the barcode… (' + tries + ' tries)');
        await pause();
      }
      return {code: null, tries: tries, ms: Date.now() - t0};
    } finally {
      URL.revokeObjectURL(img.src);
    }
  }
  return {decode: decode, read: read, grab: grab, prep: prep, clean: clean, upcEtoA: upcEtoA, checkOk: checkOk};
})();

/* Live camera: a full-screen viewfinder that reads barcodes from the video, several times a second.
 * WMR_CAM.open(onCode, onPhoto): onCode(code) when a barcode is read (same number in 2 frames),
 * onPhoto() when the person taps "Take a photo instead" (or the camera cannot start). */
var WMR_CAM = (function () {
  var st = null;
  function el(h) { var d = document.createElement('div'); d.innerHTML = h; return d.firstChild; }
  function beep() {
    try {
      var A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      var a = beep.a || (beep.a = new A()), o = a.createOscillator(), g = a.createGain();
      o.frequency.value = 1450; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.09);
    } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
  }
  function close() {
    if (!st) return;
    st.run = false;
    try { st.stream && st.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    st.box.remove(); document.body.style.overflow = ''; st = null;
  }
  async function loop(s) {
    var n = 0, last = null, lastN = 0;
    while (s.run) {
      var v = s.video, W = v.videoWidth, H = v.videoHeight;
      if (W && H && v.readyState >= 2) {
        n++;
        // alternate: the middle band at full detail (small barcodes), the whole frame smaller (big / turned ones),
        // and every 3rd frame a contrast-stretched copy (dim shelf, glare)
        var k = n % 3, d = k === 1 ? WMR_DECODE.grab(v, W, H, 1600, [0.3, 0.7], 'plain')
                          : k === 2 ? WMR_DECODE.grab(v, W, H, 1000, null, 'plain')
                          : WMR_DECODE.grab(v, W, H, 1400, [0.2, 0.8], 'stretch');
        var rs = [];
        try { rs = await WMR_DECODE.read(d, {tryDownscale: k !== 1}); } catch (e) {}
        if (!s.run) return;
        if (rs.length) {
          var c = rs[0].code;
          if (c === last && n - lastN <= 8) { beep(); var cb = s.onCode; close(); cb(c); return; }
          last = c; lastN = n;
          s.msg.textContent = 'Reading ' + c + '…';
        }
        s.frames = n;
      }
      await new Promise(function (r) { setTimeout(r, 40); });
    }
  }
  async function open(onCode, onPhoto) {
    close();
    var box = el('<div style="position:fixed;inset:0;z-index:100;background:#000;display:flex;flex-direction:column">' +
      '<div style="position:relative;flex:1;overflow:hidden"><video playsinline muted autoplay style="width:100%;height:100%;object-fit:cover"></video>' +
      '<div style="position:absolute;left:7%;right:7%;top:36%;height:28%;border:3px solid rgba(255,255,255,.9);border-radius:14px;box-shadow:0 0 0 2000px rgba(0,0,0,.35)">' +
      '<div style="position:absolute;left:4%;right:4%;top:50%;height:2px;background:#f97316;opacity:.9"></div></div>' +
      '<div class="cmsg" style="position:absolute;left:0;right:0;top:calc(14px + env(safe-area-inset-top));text-align:center;color:#fff;font:600 16px -apple-system,sans-serif;text-shadow:0 1px 3px #000">Starting the camera…</div></div>' +
      '<div style="display:flex;gap:8px;padding:10px 10px calc(10px + env(safe-area-inset-bottom));background:#111">' +
      '<button class="btn cclose" style="flex:none">✕</button><button class="btn czoom" style="flex:none" hidden>1×</button>' +
      '<button class="btn ctorch" style="flex:none" hidden>💡</button><button class="btn pri cphoto" style="flex:1">📷 Take a photo instead</button></div></div>');
    document.body.appendChild(box); document.body.style.overflow = 'hidden';
    var s = st = {box: box, video: box.querySelector('video'), msg: box.querySelector('.cmsg'), onCode: onCode, run: true};
    box.querySelector('.cclose').onclick = close;
    box.querySelector('.cphoto').onclick = function () { close(); onPhoto(); };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { close(); onPhoto('This browser has no live camera here. Take a photo instead.'); return; }
    try {
      WMR_DECODE.prep();
      s.stream = await navigator.mediaDevices.getUserMedia({audio: false,
        video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}}});
    } catch (e) {
      close();
      onPhoto(/NotAllowed|Permission/i.test(String(e && e.name)) ?
        'Camera permission is off. On iPhone: Settings → Safari → Camera → Allow (or tap "aA" → Website Settings). Taking a photo works meanwhile.' :
        'The camera could not start (' + (e && e.name || e) + '). Take a photo instead.');
      return;
    }
    if (!st || st !== s) { s.stream.getTracks().forEach(function (t) { t.stop(); }); return; }
    s.video.srcObject = s.stream;
    try { await s.video.play(); } catch (e) {}
    var tr = s.stream.getVideoTracks()[0], caps = tr && tr.getCapabilities ? tr.getCapabilities() : {};
    try { if ((caps.focusMode || []).indexOf('continuous') >= 0) await tr.applyConstraints({advanced: [{focusMode: 'continuous'}]}); } catch (e) {}
    if (caps.zoom && caps.zoom.max > 1) {        // newer iPhones cannot focus up close: zoom lets you hold the phone further away
      var zb = box.querySelector('.czoom'), steps = [1, 1.5, 2, 3].filter(function (z) { return z >= (caps.zoom.min || 1) && z <= caps.zoom.max; }), zi = 0;
      zb.hidden = false;
      zb.onclick = function () { zi = (zi + 1) % steps.length; tr.applyConstraints({advanced: [{zoom: steps[zi]}]}).catch(function () {}); zb.textContent = steps[zi] + '×'; };
    }
    if (caps.torch) {
      var tb = box.querySelector('.ctorch'), on = false; tb.hidden = false;
      tb.onclick = function () { on = !on; tr.applyConstraints({advanced: [{torch: on}]}).catch(function () {}); tb.style.background = on ? '#fbbf24' : ''; };
    }
    s.msg.textContent = 'Point at the barcode · hold steady about 6 inches away';
    loop(s);
  }
  return {open: open, close: close, state: function () { return st; }};
})();
