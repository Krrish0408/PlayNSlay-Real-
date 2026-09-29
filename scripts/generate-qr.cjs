const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const targetUrl = "https://playnslay.onrender.com";
const artifactDir = "/Users/krrishjain7470/.gemini/antigravity-ide/brain/8c07c90b-79db-49f0-8e00-8f49eab07c88";
const publicDir = path.join(process.cwd(), "client", "public");
const serverPublicDir = path.join(process.cwd(), "public");

[publicDir, serverPublicDir, artifactDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const logoPath = path.join(process.cwd(), "attached_assets", "PLAY_N_SLAY_LOGO__1768593233107.jpeg");
let logoBase64 = "";
if (fs.existsSync(logoPath)) {
  logoBase64 = "data:image/jpeg;base64," + fs.readFileSync(logoPath).toString("base64");
}

async function run() {
  // 1. High-res 2048x2048 PNG
  const pngBuffer = await QRCode.toBuffer(targetUrl, {
    errorCorrectionLevel: "H",
    type: "png",
    width: 2048,
    margin: 2,
    color: {
      dark: "#000000",
      light: "#FFFFFF",
    },
  });

  // 2. Vector SVG
  const svgString = await QRCode.toString(targetUrl, {
    type: "svg",
    errorCorrectionLevel: "H",
    margin: 2,
    color: {
      dark: "#000000",
      light: "#FFFFFF",
    },
  });

  // 3. Data URL for embedded HTML standee
  const qrDataUrl = await QRCode.toDataURL(targetUrl, {
    errorCorrectionLevel: "H",
    width: 1000,
    margin: 1,
    color: {
      dark: "#05070a",
      light: "#ffffff",
    },
  });

  // Write PNG & SVG
  [publicDir, serverPublicDir, artifactDir].forEach((d) => {
    fs.writeFileSync(path.join(d, "playnslay-qr-code.png"), pngBuffer);
    fs.writeFileSync(path.join(d, "playnslay-qr-code.svg"), svgString);
  });

  // 4. Generate beautiful printable HTML standee
  const standeeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Play N' Slay - Store QR Code Standee</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Rajdhani:wght@600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #00f3ff;
      --secondary: #bd00ff;
      --accent: #ff0055;
      --dark: #07090e;
      --card-bg: #11151f;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      background: radial-gradient(circle at 50% 20%, #101626 0%, #05070a 100%);
      font-family: 'Inter', sans-serif;
      color: #ffffff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 30px 20px;
    }
    .print-actions {
      margin-bottom: 24px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: center;
    }
    .btn {
      background: linear-gradient(135deg, var(--primary), #00a8ff);
      color: #05070a;
      font-weight: 800;
      font-size: 15px;
      padding: 12px 24px;
      border-radius: 12px;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      box-shadow: 0 0 25px rgba(0, 243, 255, 0.4);
      transition: all 0.2s ease;
      font-family: 'Rajdhani', sans-serif;
      letter-spacing: 0.5px;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 0 35px rgba(0, 243, 255, 0.6);
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: none;
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.16);
      box-shadow: 0 0 15px rgba(255, 255, 255, 0.1);
    }

    /* Standee Display Card */
    .standee-card {
      width: 440px;
      max-width: 100%;
      background: radial-gradient(circle at 50% 0%, #151d2f 0%, #0d121c 60%, #07090e 100%);
      border: 2px solid rgba(0, 243, 255, 0.45);
      border-radius: 32px;
      padding: 36px 30px;
      text-align: center;
      position: relative;
      box-shadow: 0 0 60px rgba(0, 243, 255, 0.18), 0 25px 50px rgba(0, 0, 0, 0.9);
      overflow: hidden;
    }

    .standee-card::before {
      content: "";
      position: absolute;
      top: -120px;
      left: 50%;
      transform: translateX(-50%);
      width: 320px;
      height: 220px;
      background: radial-gradient(circle, rgba(0, 243, 255, 0.28) 0%, transparent 70%);
      pointer-events: none;
    }

    /* Brand Header */
    .brand-header {
      margin-bottom: 20px;
      position: relative;
      z-index: 1;
    }
    .logo-img {
      width: 80px;
      height: 80px;
      border-radius: 20px;
      border: 2px solid var(--primary);
      box-shadow: 0 0 30px rgba(0, 243, 255, 0.4);
      object-fit: cover;
      margin-bottom: 12px;
    }
    .brand-title {
      font-family: 'Orbitron', sans-serif;
      font-size: 28px;
      font-weight: 900;
      letter-spacing: 2px;
      color: #ffffff;
      text-transform: uppercase;
      line-height: 1.15;
    }
    .brand-title span {
      color: var(--primary);
      text-shadow: 0 0 20px rgba(0, 243, 255, 0.7);
    }
    .brand-subtitle {
      font-family: 'Rajdhani', sans-serif;
      font-size: 15px;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: #9cb1d4;
      margin-top: 4px;
      font-weight: 700;
    }

    /* Action Banner */
    .cta-banner {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(0, 243, 255, 0.12);
      border: 1px solid rgba(0, 243, 255, 0.5);
      padding: 8px 22px;
      border-radius: 30px;
      font-family: 'Orbitron', sans-serif;
      font-size: 12px;
      font-weight: 800;
      color: var(--primary);
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-bottom: 18px;
      box-shadow: 0 0 20px rgba(0, 243, 255, 0.2);
    }

    /* QR Box */
    .qr-frame {
      background: #ffffff;
      padding: 16px;
      border-radius: 22px;
      display: inline-block;
      box-shadow: 0 0 40px rgba(0, 243, 255, 0.35), inset 0 0 0 4px #07090e;
      position: relative;
      margin: 4px 0 18px;
    }
    .qr-image {
      width: 250px;
      height: 250px;
      display: block;
      image-rendering: pixelated;
    }

    /* Perks Grid */
    .perks-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      text-align: left;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 14px 18px;
      margin-bottom: 18px;
      font-size: 12.5px;
      color: #d6e2f5;
    }
    .perk-item {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .perk-bullet {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--primary);
      box-shadow: 0 0 10px var(--primary);
      flex-shrink: 0;
    }

    /* URL & Address */
    .url-display {
      font-family: 'Orbitron', monospace;
      font-size: 14px;
      color: var(--primary);
      font-weight: 800;
      letter-spacing: 1.5px;
      background: rgba(0, 0, 0, 0.5);
      padding: 8px 16px;
      border-radius: 10px;
      border: 1px solid rgba(0, 243, 255, 0.3);
      margin-bottom: 12px;
      display: inline-block;
    }
    .store-address {
      font-size: 11px;
      color: #8a9bb5;
      line-height: 1.5;
    }

    /* Print Styles */
    @media print {
      body {
        background: #ffffff !important;
        padding: 0 !important;
        color: #000000 !important;
      }
      .print-actions {
        display: none !important;
      }
      .standee-card {
        border: 2px solid #000000 !important;
        box-shadow: none !important;
        background: #ffffff !important;
        color: #000000 !important;
        width: 100% !important;
        max-width: 480px !important;
        margin: auto !important;
        padding: 30px !important;
      }
      .brand-title {
        color: #000000 !important;
      }
      .brand-title span {
        color: #0077cc !important;
        text-shadow: none !important;
      }
      .brand-subtitle {
        color: #555555 !important;
      }
      .cta-banner {
        background: #eef6ff !important;
        border-color: #0077cc !important;
        color: #0077cc !important;
        box-shadow: none !important;
      }
      .perks-list {
        background: #f8fafc !important;
        border-color: #e2e8f0 !important;
        color: #1e293b !important;
      }
      .perk-bullet {
        background: #0077cc !important;
        box-shadow: none !important;
      }
      .url-display {
        background: #f1f5f9 !important;
        border-color: #cbd5e1 !important;
        color: #0077cc !important;
      }
      .store-address {
        color: #64748b !important;
      }
    }
  </style>
</head>
<body>

  <div class="print-actions">
    <button class="btn" onclick="window.print()">
      🖨️ Print Standee / Poster
    </button>
    <a href="playnslay-qr-code.png" download="playnslay-qr-code.png" class="btn btn-secondary">
      ⬇️ Download QR PNG (2048x2048)
    </a>
    <a href="playnslay-qr-code.svg" download="playnslay-qr-code.svg" class="btn btn-secondary">
      ⬇️ Download QR Vector SVG
    </a>
  </div>

  <div class="standee-card">
    <div class="brand-header">
      ${logoBase64 ? `<img src="${logoBase64}" alt="Play N' Slay Logo" class="logo-img">` : ""}
      <h1 class="brand-title">PLAY N' <span>SLAY</span></h1>
      <p class="brand-subtitle">Gaming Lounge & Esports Arena</p>
    </div>

    <div class="cta-banner">
      ⚡ SCAN TO BOOK & EXPLORE ⚡
    </div>

    <div class="qr-frame">
      <img src="${qrDataUrl}" alt="Scan QR Code to visit Play N' Slay" class="qr-image">
    </div>

    <div class="perks-list">
      <div class="perk-item">
        <span class="perk-bullet"></span>
        <span><strong>Live Station Status:</strong> PS5, PS4, Racing Sim & VR</span>
      </div>
      <div class="perk-item">
        <span class="perk-bullet"></span>
        <span><strong>Browse 38+ Titles:</strong> Find multiplayer & co-op games</span>
      </div>
      <div class="perk-item">
        <span class="perk-bullet"></span>
        <span><strong>Instant Booking:</strong> Reserve your slot & skip the line</span>
      </div>
    </div>

    <div class="url-display">playnslay.onrender.com</div>

    <p class="store-address">
      📍 2nd Floor, Shivarth Plaza (In front of Ranjhi Thana), Ranjhi, Jabalpur<br>
      📞 +91 8817978822 • Open Daily 10:00 AM – 10:00 PM
    </p>
  </div>

</body>
</html>`;

  [publicDir, serverPublicDir, artifactDir].forEach((d) => {
    fs.writeFileSync(path.join(d, "offline-store-qr-standee.html"), standeeHtml);
  });

  console.log("Successfully generated all QR assets in public and artifacts!");
}

run().catch(console.error);
