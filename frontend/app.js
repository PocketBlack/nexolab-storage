(() => {
  const API = (window.NEXO_API_BASE_URL || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  const drop = $("dropzone"), picker = $("fileInput"), browse = $("browseBtn");
  const list = $("fileList"), upload = $("uploadBtn"), cancel = $("cancelUploadBtn");
  const clearBtn = $("clearFilesBtn"), status = $("status");
  const results = $("results"), cards = $("resultCards");
  const SESSION_KEY = "nexo_private_session_v1";
  let sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, sessionId);
  }
  let files = [], uploading = false, controller = null, servicePaused = false;
  const progressState = new Map();
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
    if (files.length < before + fresh.length) {
      say("Se omitieron archivos duplicados de la selección.");
    } else if (uploading && files.length > before) {
      say((files.length - before) + " archivo(s) agregado(s) a la cola. Se subirán al terminar el actual.");
    }
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
      const saved = progressState.get(file);
      row.querySelector(".file-meta").textContent = saved?.meta || bytes(file.size);
      row.querySelector(".file-progress span").style.width = (saved?.percent || 0) + "%";
      row.querySelector(".file-state").textContent = saved?.label || "Listo";
      row.querySelector(".remove-file").addEventListener("click", () => {
        if (uploading) return;
        progressState.delete(file);
        files.splice(index, 1);
        render();
        say("Archivo quitado de la selección.");
      });
      list.append(row);
    });
    upload.disabled = !files.length || uploading || servicePaused;
    upload.innerHTML = "Subir " + (files.length || "") + " archivo" +
      (files.length === 1 ? "" : "s") + ' <span aria-hidden="true">↗</span>';
    clearBtn.disabled = !files.length || uploading;
    clearBtn.hidden = !files.length || uploading;
    cancel.hidden = !uploading;
    cancel.disabled = false;
    browse.disabled = false;
  }
  function progress(index, percent, label) {
    const row = list.querySelector('[data-index="' + index + '"]');
    if (!row) return;
    const file = files[index];
    if (file) {
      const saved = progressState.get(file) || {};
      progressState.set(file, { ...saved, percent, label });
    }
    row.querySelector(".file-progress span").style.width = percent + "%";
    row.querySelector(".file-state").textContent = label;
  }
  async function post(path, data, signal) {
    const response = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, sessionId }),
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
      if (row) {
        const meta = bytes(file.size) + " · " + (speed / 1024 / 1024).toFixed(2) + " MB/s · " +
          (eta ? "~" + Math.ceil(eta / 60) + " min restantes" : "calculando velocidad");
        const saved = progressState.get(file) || {};
        progressState.set(file, { ...saved, meta });
        row.querySelector(".file-meta").textContent = meta;
      }
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
  function card(file, url, key) {
    const element = document.createElement("article");
    element.className = "result-card";
    const heading = document.createElement("h3");
    heading.textContent = file.name || file.filename || "Archivo";
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
    expiry.textContent = "Enlace válido 24 horas · Archivo disponible hasta 7 días";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-file-btn";
    remove.textContent = "Eliminar archivo";
    remove.addEventListener("click", async () => {
      if (!key || remove.disabled) return;
      if (!confirm("¿Eliminar este archivo definitivamente? Los enlaces dejarán de funcionar.")) return;
      remove.disabled = true;
      remove.textContent = "Eliminando…";
      try {
        await post("/api/files/delete", { key });
        element.remove();
        if (!cards.childElementCount) results.hidden = true;
        say("Archivo eliminado correctamente.");
      } catch (error) {
        remove.disabled = false;
        remove.textContent = "Eliminar archivo";
        say("No se pudo eliminar el archivo: " + error.message, true);
      }
    });
    element.append(heading, qr, linkRow, expiry, remove);
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
    if (!cards.childElementCount) results.hidden = true;
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
        card(file, download.downloadUrl, key);
        results.hidden = false;
        progress(index, 100, "Completado");
      }
      say("Transferencia completada. Tus enlaces están listos.");
      files.forEach((file) => progressState.delete(file));
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
    files.forEach((file) => progressState.delete(file));
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

  async function checkServiceStatus() {
    try {
      const response = await fetch(API + "/api/service-status", { cache: "no-store" });
      if (!response.ok) return;
      const state = await response.json();
      servicePaused = Boolean(state.uploadsPaused);
      if (servicePaused) {
        upload.disabled = true;
        say("Las nuevas cargas están temporalmente pausadas. Tus archivos existentes siguen disponibles para descargar.", true);
      }
    } catch (_) { /* Status check must not block access to existing files. */ }
  }

  async function loadSessionFiles() {
    try {
      const data = await post("/api/files", {});
      cards.replaceChildren();
      (data.files || []).forEach((item) => card({
        name: item.filename, size: item.size
      }, item.downloadUrl, item.key));
      results.hidden = !(data.files || []).length;
      if ((data.files || []).length) say("Se recuperaron " + data.files.length + " archivo(s). Los archivos se eliminan automáticamente a los 7 días; puedes borrarlos antes.");
    } catch (error) {
      say("No se pudo recuperar el historial de esta sesión: " + error.message, true);
    }
  }
  const newSessionBtn = $("newSessionBtn");
  if (newSessionBtn) newSessionBtn.addEventListener("click", () => {
    if (uploading) return;
    if (!confirm("¿Crear una sesión privada nueva? Los archivos actuales seguirán guardados, pero esta sesión dejará de mostrarlos.")) return;
    localStorage.removeItem(SESSION_KEY);
    location.reload();
  });
  render();
  loadSessionFiles();
})();