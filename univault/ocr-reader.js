(() => {
  const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
  const PDFJS_WORKER_CDN =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  const TESSERACT_CDN =
    "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

  const loadedScripts = new Map();

  function loadScript(src) {
    if (loadedScripts.has(src)) return loadedScripts.get(src);
    const p = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.crossOrigin = "anonymous";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Could not load library: ${src}`));
      document.head.appendChild(s);
    });
    loadedScripts.set(src, p);
    return p;
  }

  async function ensurePdfJs() {
    if (!window.pdfjsLib) {
      await loadScript(PDFJS_CDN);
    }
    if (window.pdfjsLib?.GlobalWorkerOptions) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
    }
    return window.pdfjsLib;
  }

  async function ensureTesseract() {
    if (!window.Tesseract) {
      await loadScript(TESSERACT_CDN);
    }
    return window.Tesseract;
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read file."));
      reader.readAsDataURL(file);
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read file bytes."));
      reader.readAsArrayBuffer(file);
    });
  }

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read text file."));
      reader.readAsText(file);
    });
  }

  function dataUrlToBase64(dataUrl) {
    const idx = String(dataUrl || "").indexOf(",");
    return idx >= 0 ? dataUrl.slice(idx + 1) : String(dataUrl || "");
  }

  async function recognizeCanvasOcr(canvas, label, onStatus) {
    const Tesseract = await ensureTesseract();
    if (!Tesseract?.recognize) {
      throw new Error("OCR engine could not initialize.");
    }
    const result = await Tesseract.recognize(canvas, "eng", {
      logger: (m) => {
        if (m?.status === "recognizing text" && typeof m.progress === "number") {
          const pct = Math.round(m.progress * 100);
          onStatus?.(`${label} (${pct}%)...`);
        }
      },
    });
    return String(result?.data?.text || "").trim();
  }

  async function preprocessImageAndOcr(file, onStatus) {
    onStatus?.(`Reading image "${file.name}"...`);
    const dataUrl = await readAsDataURL(file);
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not decode the uploaded image."));
      el.src = dataUrl;
    });

    const natW = img.naturalWidth || img.width || 1000;
    const natH = img.naturalHeight || img.height || 1000;

    // 1. High-contrast grayscale canvas for OCR accuracy
    const ocrScale = natW < 1200 ? Math.min(2.2, 1400 / natW) : Math.min(1, 2400 / natW);
    const ocrCanvas = document.createElement("canvas");
    ocrCanvas.width = Math.max(1, Math.round(natW * ocrScale));
    ocrCanvas.height = Math.max(1, Math.round(natH * ocrScale));
    const octx = ocrCanvas.getContext("2d");
    if (octx) {
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);
      octx.filter = "grayscale(1) contrast(1.45) brightness(1.06)";
      octx.drawImage(img, 0, 0, ocrCanvas.width, ocrCanvas.height);
    }

    // 2. Clean compressed JPEG canvas for Gemini multimodal visual verification
    const visScale = Math.min(1, 1600 / Math.max(natW, natH));
    const visCanvas = document.createElement("canvas");
    visCanvas.width = Math.max(1, Math.round(natW * visScale));
    visCanvas.height = Math.max(1, Math.round(natH * visScale));
    const vctx = visCanvas.getContext("2d");
    if (vctx) {
      vctx.fillStyle = "#ffffff";
      vctx.fillRect(0, 0, visCanvas.width, visCanvas.height);
      vctx.drawImage(img, 0, 0, visCanvas.width, visCanvas.height);
    }
    const visualBase64 = dataUrlToBase64(visCanvas.toDataURL("image/jpeg", 0.86));

    let ocrText = "";
    try {
      onStatus?.(`Running client-side OCR on "${file.name}"...`);
      ocrText = await recognizeCanvasOcr(ocrCanvas, `OCR scanning "${file.name}"`, onStatus);
    } catch (ocrErr) {
      console.warn("Image OCR skipped, continuing with image upload:", ocrErr);
    }

    const thumbScale = Math.min(1, 240 / Math.max(natW, natH));
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = Math.max(1, Math.round(natW * thumbScale));
    thumbCanvas.height = Math.max(1, Math.round(natH * thumbScale));
    const tctx = thumbCanvas.getContext("2d");
    if (tctx) {
      tctx.fillStyle = "#ffffff";
      tctx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
      tctx.drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height);
    }
    const thumbnailDataUrl = thumbCanvas.toDataURL("image/jpeg", 0.8);

    return {
      preprocessedText: ocrText,
      dataBase64: visualBase64,
      mimeType: "image/jpeg",
      ocrUsed: Boolean(ocrText),
      thumbnailDataUrl,
    };
  }

  function captureVideoThumbnail(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const vid = document.createElement("video");
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = "metadata";
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(val);
      };
      const timer = setTimeout(() => done(""), 3500);
      vid.onloadeddata = () => {
        try {
          vid.currentTime = Math.min(0.4, (vid.duration || 1) * 0.15);
        } catch {
          clearTimeout(timer);
          done("");
        }
      };
      vid.onseeked = () => {
        clearTimeout(timer);
        try {
          const w = vid.videoWidth || 320;
          const h = vid.videoHeight || 180;
          const s = Math.min(1, 240 / Math.max(w, h));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(w * s));
          c.height = Math.max(1, Math.round(h * s));
          const ctx = c.getContext("2d");
          if (!ctx) return done("");
          ctx.drawImage(vid, 0, 0, c.width, c.height);
          done(c.toDataURL("image/jpeg", 0.8));
        } catch {
          done("");
        }
      };
      vid.onerror = () => {
        clearTimeout(timer);
        done("");
      };
      vid.src = url;
    });
  }

  function textItemsToLines(items) {
    if (!Array.isArray(items) || !items.length) return "";
    let lines = [];
    let currentLine = [];
    let lastY = null;
    for (const item of items) {
      const str = String(item?.str || "");
      const y = Array.isArray(item?.transform) ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
        lines.push(currentLine.join(" ").replace(/\s+/g, " ").trim());
        currentLine = [];
      }
      if (str.trim()) currentLine.push(str.trim());
      if (item?.hasEOL) {
        lines.push(currentLine.join(" ").replace(/\s+/g, " ").trim());
        currentLine = [];
        lastY = null;
      } else {
        lastY = y;
      }
    }
    if (currentLine.length) {
      lines.push(currentLine.join(" ").replace(/\s+/g, " ").trim());
    }
    return lines.filter(Boolean).join("\n").trim();
  }

  async function extractPdfClientSide(file, onStatus) {
    onStatus?.(`Reading PDF "${file.name}" in browser...`);
    const pdfjsLib = await ensurePdfJs();
    const buf = await readAsArrayBuffer(file);
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const total = Math.min(pdf.numPages || 0, 25);
    const pages = [];
    let ocrUsed = false;
    let thumbnailDataUrl = "";

    for (let i = 1; i <= total; i++) {
      onStatus?.(`Reading PDF page ${i} of ${total}...`);
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      let pageText = textItemsToLines(tc.items);
      const alphaLen = pageText.replace(/[^a-zA-Z0-9]/g, "").length;

      // Render page 1 thumbnail for the upload-drop preview
      if (i === 1 && !thumbnailDataUrl) {
        try {
          const baseVp = page.getViewport({ scale: 1 });
          const thumbScale = Math.min(1.5, 240 / Math.max(baseVp.width || 600, 1));
          const thumbVp = page.getViewport({ scale: thumbScale });
          const tcCanvas = document.createElement("canvas");
          tcCanvas.width = Math.max(1, Math.round(thumbVp.width));
          tcCanvas.height = Math.max(1, Math.round(thumbVp.height));
          const tctx = tcCanvas.getContext("2d");
          if (tctx) {
            tctx.fillStyle = "#ffffff";
            tctx.fillRect(0, 0, tcCanvas.width, tcCanvas.height);
            await page.render({ canvasContext: tctx, viewport: thumbVp }).promise;
            thumbnailDataUrl = tcCanvas.toDataURL("image/jpeg", 0.82);
          }
        } catch {}
      }

      // Run client-side OCR on scanned / image-based PDF pages
      if (alphaLen < 30) {
        try {
          onStatus?.(`Scanned PDF page ${i}/${total} detected — running OCR...`);
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport }).promise;
            const ocrPageText = await recognizeCanvasOcr(
              canvas,
              `OCR PDF page ${i}/${total}`,
              onStatus
            );
            if (ocrPageText) {
              pageText = ocrPageText;
              ocrUsed = true;
            }
          }
        } catch (ocrErr) {
          console.warn(`PDF page ${i} OCR failed:`, ocrErr);
        }
      }

      if (pageText) {
        pages.push(total > 1 ? `--- Page ${i} ---\n${pageText}` : pageText);
      }
    }

    return {
      text: pages.join("\n\n").trim(),
      ocrUsed,
      pageCount: total,
      thumbnailDataUrl,
    };
  }

  function detectClientKind(file) {
    const name = String(file?.name || "").toLowerCase();
    const mime = String(file?.type || "").toLowerCase();
    if (name.endsWith(".pdf") || mime === "application/pdf") return "pdf";
    if (
      /\.(png|jpe?g|webp|bmp|gif)$/.test(name) ||
      mime.startsWith("image/")
    ) {
      return "image";
    }
    if (/\.(txt|md|csv)$/.test(name) || mime.startsWith("text/")) return "text";
    return "binary";
  }

  async function processFile(file, onStatus) {
    if (!file) throw new Error("No file selected.");
    if (file.size > 20 * 1024 * 1024) {
      throw new Error("File is larger than 20 MB. Please upload a smaller file.");
    }

    const {
      data: { session },
    } = await sb.auth.getSession();
    if (!session?.access_token) {
      throw new Error("Please sign in first.");
    }

    const kind = detectClientKind(file);
    let dataBase64 = "";
    let mimeType = file.type || "application/octet-stream";
    let preprocessedText = "";
    let ocrUsed = false;
    let thumbnailDataUrl = "";
    let pageCount = 0;

    if (kind === "image") {
      const imgRes = await preprocessImageAndOcr(file, onStatus);
      preprocessedText = imgRes.preprocessedText;
      dataBase64 = imgRes.dataBase64;
      mimeType = imgRes.mimeType;
      ocrUsed = imgRes.ocrUsed;
      thumbnailDataUrl = imgRes.thumbnailDataUrl || "";
    } else if (kind === "pdf") {
      try {
        const pdfRes = await extractPdfClientSide(file, onStatus);
        preprocessedText = pdfRes.text;
        ocrUsed = pdfRes.ocrUsed;
        thumbnailDataUrl = pdfRes.thumbnailDataUrl || "";
        pageCount = pdfRes.pageCount || 0;
      } catch (pdfErr) {
        console.warn("Client PDF extraction failed, falling back to server PDF processing:", pdfErr);
      }
      if (!preprocessedText || preprocessedText.replace(/\s+/g, "").length < 60) {
        if (file.size <= 4 * 1024 * 1024) {
          const dUrl = await readAsDataURL(file);
          dataBase64 = dataUrlToBase64(dUrl);
          mimeType = "application/pdf";
        } else if (!preprocessedText) {
          throw new Error("Could not extract readable text from this PDF.");
        }
      }
    } else if (kind === "text") {
      onStatus?.(`Reading "${file.name}"...`);
      preprocessedText = (await readAsText(file)).trim();
      mimeType = "text/plain";
    } else {
      onStatus?.(`Reading "${file.name}" for Gemini AI...`);
      const lowerName = String(file.name || "").toLowerCase();
      if (/\.(mp4|webm|mov)$/.test(lowerName) || mimeType.startsWith("video/")) {
        thumbnailDataUrl = await captureVideoThumbnail(file);
      }
      const dUrl = await readAsDataURL(file);
      dataBase64 = dataUrlToBase64(dUrl);
    }

    onStatus?.(
      preprocessedText
        ? `Sending pre-processed${ocrUsed ? " OCR" : ""} text to Gemini AI...`
        : `Processing "${file.name}" with Gemini AI...`
    );

    const postProcessFile = async (accessToken) =>
      fetch("/api/ai-process-file", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          fileName: file.name,
          mimeType,
          dataBase64,
          preprocessedText,
          ocrUsed,
        }),
      });

    let res = await postProcessFile(session.access_token);
    if (res.status === 401 && sb?.auth?.refreshSession) {
      try {
        const refreshed = await sb.auth.refreshSession();
        const nextToken = refreshed?.data?.session?.access_token;
        if (nextToken) {
          res = await postProcessFile(nextToken);
        }
      } catch {}
    }

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      if (res.status === 413) {
        throw new Error(
          "File exceeds the hosted upload limit (~4 MB). Please upload a smaller or compressed file."
        );
      }
      throw new Error(`Upload failed (${res.status}).`);
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to process file.");
    return {
      ...data,
      clientPreprocessedText: preprocessedText,
      ocrUsed: Boolean(data.ocrUsed || ocrUsed),
      thumbnailDataUrl,
      pageCount,
      fileSize: file.size,
    };
  }

  function formatSize(bytes) {
    const n = Number(bytes || 0);
    if (!n) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fileBadge(fileName, mediaType) {
    const ext = String(fileName || "").split(".").pop()?.toUpperCase() || "";
    if (ext && ext.length <= 5) return ext;
    if (mediaType === "audio") return "AUDIO";
    if (mediaType === "video") return "VIDEO";
    return "DOC";
  }

  function renderUploadPreview(containerEl, data, onClear) {
    if (!containerEl) return;
    if (!data) {
      containerEl.hidden = true;
      containerEl.innerHTML = "";
      return;
    }

    const thumbHtml = data.thumbnailDataUrl
      ? `<img src="${data.thumbnailDataUrl}" alt="Preview of ${esc(data.fileName)}">`
      : `<span class="up-thumb-badge">${esc(fileBadge(data.fileName, data.mediaType))}</span>`;

    const rawSnippet = String(
      data.extractedText || data.transcript || data.clientPreprocessedText || data.summary || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const snippet = rawSnippet
      ? rawSnippet.slice(0, 260) + (rawSnippet.length > 260 ? "..." : "")
      : "No text snippet extracted.";

    const metaParts = [
      formatSize(data.fileSize),
      data.pageCount ? `${data.pageCount} page${data.pageCount === 1 ? "" : "s"}` : "",
      data.ocrUsed ? "OCR scanned" : "",
      data.mediaType === "audio"
        ? "Audio transcript"
        : data.mediaType === "video"
          ? "Video transcript"
          : "Written document",
    ].filter(Boolean);

    containerEl.hidden = false;
    containerEl.innerHTML = `
      <div class="up-thumb">${thumbHtml}</div>
      <div class="up-snippet">
        <div class="up-snippet-head">
          <strong>${esc(data.fileName)}</strong>
          <small>${esc(metaParts.join(" · "))}</small>
        </div>
        <p class="up-snippet-text">${esc(snippet)}</p>
        <div class="up-snippet-actions">
          <span class="up-snippet-hint">Click box to replace file</span>
          <button type="button" class="ghost up-clear-btn">Clear preview</button>
        </div>
      </div>
    `;

    const clr = containerEl.querySelector(".up-clear-btn");
    if (clr && typeof onClear === "function") {
      clr.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClear();
      };
    }
  }

  function normSpaces(v) {
    return String(v || "").replace(/\s+/g, " ").trim();
  }

  function normCourseCode(v) {
    const cleaned = normSpaces(v).toUpperCase().replace(/[-_]+/g, " ");
    const compact = cleaned.replace(/[^A-Z0-9]/g, "");
    const m = compact.match(/^([A-Z]+)(\d+[A-Z]*)$/);
    return { canonical: m ? `${m[1]} ${m[2]}` : cleaned, key: compact };
  }

  function normBodyKey(v) {
    return String(v || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  window.uvFileTools = {
    processFile,
    renderUploadPreview,
    normSpaces,
    normCourseCode,
    normBodyKey,
  };
})();
