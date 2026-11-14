(() => {
  const API = (window.NEXO_API_BASE_URL || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  const drop = $("dropzone"), picker = $("fileInput"), browse = $("browseBtn");
  const list = $("fileList"), upload = $("uploadBtn"), cancel = $("cancelUploadBtn");
  const clearBtn = $("clearFilesBtn"), status = $("status");
  const results = $("results"), cards = $("resultCards");
  let files = [], uploading = false, controller = null;
  const bytes = (n) => {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
    return (n / 1024 ** i).toFixed(i ? 1 : 0) + " " + units[i];
  };
  const say = (message, bad = false) => {
    status.textContent = message;
    status.style.color = bad ? "#e29a8c" : "";
  };
  const cancelled = () => controller && controller.signal.aborted;
  const cancelError = () => {
    const error = new Error("Transferencia cancelada.");
    error.name = "AbortError";
    return error;
  };
  function add(incoming) {
    const fresh = Array.from(incoming || []);
    const before = files.length;
    files = [...files, ...fresh].filter((file, i, all) =>
      all.findIndex((item) => item.name === file.name && item.size === file.size &&
        item.lastModified === file.lastModified) === i);
    render();
    say(files.length < before + fresh.length ? "Se omitieron archivos duplicados de la selección." : "");
  }
  function render() {
    list.replaceChildren();
    files.forEach((file, index) => {
      const row = document.createElement("div");
      row.className = "file-row";
      row.dataset.index = index;
      row.innerHTML = '<div class="file-icon"></div><div class="file-info"><div class="file-name"></div><div class="file-meta"></div><div class="file-progress"><span></span></div></div><div class="file-controls"><div class="file-state">Listo</div><button class="remove-file" type="button" aria-label="Quitar archivo de la selección" title="Quitar archivo" ' +
        (uploading ? "disabled" : "") + '>×</button></div>';
      row.querySelector(".file-icon").textContent = (file.name.split(".").pop() || "FILE").slice(0, 4).toUpperCase();
      row.querySelector(".file-name").textContent = file.name;
      row.querySelector(".file-meta").textContent = bytes(file.size);
      row.querySelector(".remove-file").addEventListener("click", () => {
        if (uploading) return;
        files.splice(index, 1);
        render();
        say("Archivo quitado de la selección.");
      });
      list.append(row);
    });
    upload.disabled = !files.length || uploading;
    upload.innerHTML = "Subir " + (files.length || "") + " archivo" +
      (files.length === 1 ? "" : "s") + ' <span aria-hidden="true">↗</span>';
    clearBtn.disabled = !files.length || uploading;
    clearBtn.hidden = !files.length || uploading;
    cancel.hidden = !uploading;
    cancel.disabled = false;
    browse.disabled = uploading;
  }
  function progress(index, percent, label) {
    const row = list.querySelector('[data-index="' + index + '"]');
    if (!row) return;
    row.querySelector(".file-progress span").style.width = percent + "%";
    row.querySelector(".file-state").textContent = label;
  }
  async function post(path, data, signal) {
    const response = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "API error " + response.status);
    return payload;
  }
  function put(blob, url, contentType, onProgress, signal, requireEtag = false) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener("abort", abort);
        fn(value);
      };
      const abort = () => xhr.abort();
      xhr.open("PUT", url);
      if (contentType) xhr.setRequestHeader("Content-Type", contentType);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          finish(reject, new Error("Falló la subida a R2 (" + xhr.status + ")."));
          return;
        }
        if (requireEtag) {
          const etag = xhr.getResponseHeader("ETag");
          if (!etag) {
            finish(reject, new Error("R2 no expone ETag; revisa CORS del bucket."));
            return;
          }
          finish(resolve, etag);
        } else finish(resolve, true);
      };
      xhr.onerror = () => finish(reject, new Error("Error de red durante la subida."));
      xhr.onabort = () => finish(reject, cancelError());
      if (signal) {
        if (signal.aborted) return finish(reject, cancelError());
        signal.addEventListener("abort", abort, { once: true });
      }
      xhr.send(blob);
    });
  }
  async function multipart(file, index, onOverall, signal) {
    const chunkSize = 32 * 1024 * 1024;
    const concurrency = 3;
    const count = Math.ceil(file.size / chunkSize);
    const created = await post("/api/multipart/create", {
      filename: file.name, size: file.size,
      contentType: file.type || "application/octet-stream"
    }, signal);
    const parts = new Array(count);
    const loaded = new Array(count).fill(0);
    let next = 0, failed = null, lastBytes = 0, lastTime = Date.now();
    const speedTimer = setInterval(() => {
      const now = Date.now();
      const total = loaded.reduce((sum, value) => sum + value, 0);
      const speed = (total - lastBytes) / Math.max(1, now - lastTime) * 1000;
      lastBytes = total;
      lastTime = now;
      const eta = speed > 0 ? Math.ceil(Math.max(0, file.size - total) / speed) : 0;
      const row = list.querySelector('[data-index="' + index + '"]');
      if (row) row.querySelector(".file-meta").textContent =
        bytes(file.size) + " · " + (speed / 1024 / 1024).toFixed(2) + " MB/s · " +
        (eta ? "~" + Math.ceil(eta / 60) + " min restantes" : "calculando velocidad");
    }, 1000);
    async function worker() {
      while (next < count && !failed && !signal.aborted) {
        const partIndex = next++;
        const blob = file.slice(partIndex * chunkSize, Math.min(file.size, (partIndex + 1) * chunkSize));
        let etag = null;
        for (let attempt = 0; attempt < 3 && !etag && !signal.aborted; attempt++) {
          try {
            const signed = await post("/api/multipart/part-url", {
              key: created.key, uploadId: created.uploadId, partNumber: partIndex + 1
            }, signal);
            etag = await put(blob, signed.url, null, (loadedBytes) => {
              loaded[partIndex] = loadedBytes;
              onOverall(loaded.reduce((sum, value) => sum + value, 0) / file.size * 100);
            }, signal, true);
          } catch (error) {
            loaded[partIndex] = 0;
            if (signal.aborted) throw cancelError();
            if (attempt === 2) failed = error;
          }
        }
        if (etag) parts[partIndex] = { PartNumber: partIndex + 1, ETag: etag };
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
      if (signal.aborted) throw cancelError();
      if (failed) throw failed;
      await post("/api/multipart/complete", {
        key: created.key, uploadId: created.uploadId, parts
      });
      return created.key;
    } catch (error) {
      try {
        await post("/api/multipart/abort", { key: created.key, uploadId: created.uploadId });
      } catch (abortError) {
        console.warn("No se pudo confirmar el aborto multipart:", abortError.message);
      }
      throw error;
    } finally {
      clearInterval(speedTimer);
    }
  }
  function card(file, url) {
    const element = document.createElement("article");
    element.className = "result-card";
    const heading = document.createElement("h3");
    heading.textContent = file.name;
    const qr = document.createElement("div");
    qr.className = "qr-wrap";
    const linkRow = document.createElement("div");
    linkRow.className = "share-link";
    const input = document.createElement("input");
    input.readOnly = true;
    input.value = url;
    input.setAttribute("aria-label", "Enlace de descarga");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copiar";
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(url); }
      catch { input.select(); document.execCommand("copy"); }
      copy.textContent = "Copiado";
      setTimeout(() => copy.textContent = "Copiar", 1500);
    };
    linkRow.append(input, copy);
    const expiry = document.createElement("div");
    expiry.className = "link-expiry";
    expiry.textContent = "Enlace válido durante 24 horas";
    element.append(heading, qr, linkRow, expiry);
    cards.append(element);
    if (window.QRCode) new QRCode(qr, {
      text: url, width: 140, height: 140, correctLevel: QRCode.CorrectLevel.M
    });
    else qr.textContent = "QR no disponible";
  }
  async function run() {
    if (!files.length || uploading) return;
    if (!API || API.includes("YOUR-RENDER-SERVICE")) {
      say("Configura la URL de Render en frontend/config.js.", true);
      return;
    }
    controller = new AbortController();
    const signal = controller.signal;
    uploading = true;
    render();
    results.hidden = true;
    cards.replaceChildren();
    try {
      for (let index = 0; index < files.length; index++) {
        if (signal.aborted) throw cancelError();
        const file = files[index];
        progress(index, 0, "Preparando");
        say("Subiendo " + (index + 1) + " de " + files.length + ": " + file.name);
        let key;
        if (file.size > 64 * 1024 * 1024) {
          progress(index, 0, "Subida por partes");
          key = await multipart(file, index,
            (percent) => progress(index, percent, Math.floor(percent) + "%"), signal);
        } else {
          const signed = await post("/api/upload-url", {
            filename: file.name, size: file.size,
            contentType: file.type || "application/octet-stream"
          }, signal);
          progress(index, 0, "Subiendo");
          await put(file, signed.uploadUrl, file.type || "application/octet-stream",
            (loaded, total) => progress(index, loaded / total * 100,
              Math.floor(loaded / total * 100) + "%"), signal);
          key = signed.key;
        }
        if (signal.aborted) throw cancelError();
        progress(index, 100, "Generando enlace");
        const download = await post("/api/download-url", { key, filename: file.name }, signal);
        card(file, download.downloadUrl);
        results.hidden = false;
        progress(index, 100, "Completado");
      }
      say("Transferencia completada. Tus enlaces están listos.");
      files = [];
      render();
    } catch (error) {
      if (signal.aborted || error.name === "AbortError") {
        say("Subida cancelada. Los enlaces de los archivos no completados no se generaron.");
      } else {
        say(error.message || "No se pudo completar la transferencia.", true);
      }
    } finally {
      uploading = false;
      controller = null;
      render();
    }
  }
  browse.addEventListener("click", (event) => {
    event.stopPropagation();
    picker.click();
  });
  drop.addEventListener("click", (event) => {
    if (event.target !== browse) picker.click();
  });
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      picker.click();
    }
  });
  picker.addEventListener("change", () => {
    add(picker.files);
    picker.value = "";
  });
  ["dragenter", "dragover"].forEach((name) => drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.add("dragover");
  }));
  ["dragleave", "drop"].forEach((name) => drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.remove("dragover");
  }));
  drop.addEventListener("drop", (event) => add(event.dataTransfer.files));
  clearBtn.addEventListener("click", () => {
    if (uploading) return;
    files = [];
    render();
    say("Selección cancelada.");
  });
  cancel.addEventListener("click", () => {
    if (!uploading || !controller) return;
    cancel.disabled = true;
    say("Cancelando transferencia y limpiando la subida multipart…");
    controller.abort();
  });
  upload.addEventListener("click", run);
  render();
})();