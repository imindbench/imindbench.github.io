(function () {
  const canvas = document.querySelector(".hero-activity");
  if (!canvas) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SPIKE = [1.35, -1.15, 0.25];
  const ctx = canvas.getContext("2d", { alpha: true });

  let width = 0;
  let height = 0;
  let dpr = 1;
  let channels = [];
  let common = 0;
  let burstTimer = 180;
  let frame = 0;
  let raf = 0;
  let signalRgb = "124, 176, 214";

  function syncTheme() {
    signalRgb =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--hero-signal-rgb")
        .trim() || "124, 176, 214";
    draw();
  }

  function randn() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function channelCount() {
    if (height < 70) return 3;
    if (height < 120) return 5;
    if (height < 200) return 6;
    if (height < 280) return 9;
    return 11;
  }

  function makeChannel(length) {
    return {
      slow: randn() * 0.2,
      mid: 0,
      fast: 0,
      spike: 0,
      spikeGain: 0,
      burstAmp: 0,
      burstPhase: Math.random() * Math.PI * 2,
      burstDelay: 0,
      samples: new Float32Array(length),
    };
  }

  function sampleChannel(ch) {
    ch.slow = ch.slow * 0.99 + randn() * 0.02;
    ch.mid = ch.mid * 0.82 + randn() * 0.09;
    ch.fast = ch.fast * 0.28 + randn() * 0.22;

    if (ch.spike > 0) {
      ch.spike += 1;
      if (ch.spike > SPIKE.length) ch.spike = 0;
    } else if (Math.random() < 0.0018) {
      ch.spike = 1;
      ch.spikeGain = 0.7 + Math.random() * 0.9;
    }

    if (ch.burstDelay > 0) {
      ch.burstDelay -= 1;
      if (ch.burstDelay === 0) {
        ch.burstAmp = 0.28 + Math.random() * 0.22;
        ch.burstPhase = 0;
      }
    }

    let value =
      ch.slow * 0.22 +
      ch.mid * 0.2 +
      ch.fast * 0.38 +
      randn() * 0.16 +
      common * 0.08;

    if (Math.random() < 0.045) value += (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.45);
    if (ch.spike > 0) value += SPIKE[ch.spike - 1] * ch.spikeGain;
    if (ch.burstAmp > 0.02) {
      value += (Math.sin(ch.burstPhase) + randn() * 0.35) * ch.burstAmp;
      ch.burstPhase += 0.7 + randn() * 0.12;
      ch.burstAmp *= 0.986;
    }
    return value;
  }

  function pushSamples(count) {
    for (let n = 0; n < count; n += 1) {
      common = common * 0.98 + randn() * 0.03;
      burstTimer -= 1;
      if (burstTimer <= 0) {
        const seed = Math.floor(Math.random() * channels.length);
        channels.forEach((ch, i) => {
          ch.burstDelay = 4 + Math.abs(i - seed) * 7;
        });
        burstTimer = 480 + Math.floor(Math.random() * 420);
      }
      channels.forEach((ch) => {
        ch.samples.copyWithin(0, 1);
        ch.samples[ch.samples.length - 1] = sampleChannel(ch);
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    const rows = channels.length;
    const rowH = height / (rows + 0.6);
    const scale = rowH * 0.34;

    ctx.lineJoin = "miter";
    ctx.lineCap = "butt";
    ctx.miterLimit = 8;

    channels.forEach((ch, i) => {
      const y0 = rowH * (i + 0.8);
      ctx.beginPath();
      const data = ch.samples;
      for (let x = 0; x < width; x += 1) {
        const y = y0 - data[x] * scale;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(${signalRgb}, 0.42)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = channelCount();
    channels = Array.from({ length: count }, () => makeChannel(width));
    for (let i = 0; i < width; i += 1) pushSamples(1);
    draw();
  }

  function tick() {
    if (document.hidden) {
      raf = window.requestAnimationFrame(tick);
      return;
    }
    frame += 1;
    if (frame % 2 === 0) {
      pushSamples(1);
      draw();
    }
    raf = window.requestAnimationFrame(tick);
  }

  resize();
  syncTheme();
  window.addEventListener("resize", resize);
  window.addEventListener("imindbenchthemechange", syncTheme);
  if (!reduceMotion) raf = window.requestAnimationFrame(tick);
})();
