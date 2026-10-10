/* =========================================================
   LOS COMBOS DE LÍA — admin.js
   Panel de administración: CRUD de combos con categoría y
   compresión real de imágenes antes de guardarlas.
   Requiere haber ejecutado supabase.sql (columna "categoria").
   ========================================================= */
(() => {
  "use strict";

  /* El panel no depende de common.js: si falta o es una versión vieja,
     usa estas versiones propias y sigue funcionando. */
  const Lia = window.Lia || {};
  const esc = Lia.escapeHtml || (value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"));
  const money = Lia.money || (value => `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0)} USD`);
  const toast = Lia.toast || ((message, type) => { console[type === "error" ? "error" : "log"](message); if (type === "error") alert(message); });
  const NO_CATEGORY = "Sin categoría";
  const byText = (a, b) => String(a).localeCompare(String(b), "es", { sensitivity: "base" });
  const groupByCategory = Lia.groupByCategory || (list => {
    const groups = new Map();
    list.forEach(item => {
      const label = String(item.categoria || "").trim() || NO_CATEGORY;
      const key = label.toLowerCase();
      if (!groups.has(key)) groups.set(key, { name: label, items: [] });
      groups.get(key).items.push(item);
    });
    const result = [...groups.values()];
    result.forEach(group => group.items.sort((x, y) => byText(x.nombre || "", y.nombre || "")));
    result.sort((x, y) => x.name === NO_CATEGORY ? 1 : y.name === NO_CATEGORY ? -1 : byText(x.name, y.name));
    return result;
  });

  const ENV = window.ENV || {};
  const SUPABASE_URL = ENV.SUPABASE_URL || "";
  const SUPABASE_KEY = ENV.SUPABASE_KEY || ENV.SUPABASE_ANON_KEY || "";
  const configured = SUPABASE_URL && SUPABASE_KEY && !SUPABASE_URL.includes("TU-PROYECTO") && !SUPABASE_KEY.includes("TU_ANON_KEY");
  const sb = configured && window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

  const DEFAULT_DESC = "Opción disponible para solicitar y entregada con seguridad.";
  /* La lista se pide SIN la foto (pesa mucho); las fotos llegan después, una a una */
  const LIGHT_COLUMNS = "id,nombre,precio,descripcion,categoria,activo";
  const LIGHT_COLUMNS_NO_CAT = "id,nombre,precio,descripcion,activo";

  let combos = [];
  let editingId = null;
  let deletingId = null;
  let loadToken = 0;
  const photos = new Map(); // id -> imagen (data URL) o null si no tiene

  const $ = id => document.getElementById(id);
  const show = el => el?.classList.remove("is-hidden");
  const hide = el => el?.classList.add("is-hidden");

  window.addEventListener("error", e => console.error("Error JS:", e.message));
  window.addEventListener("unhandledrejection", e => console.error("Promesa sin capturar:", e.reason));

  /* Evita que una consulta se quede esperando para siempre */
  function withTimeout(promise, ms = 20000) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("La base de datos tardó demasiado en responder.")), ms))
    ]);
  }

  const placeholder = '<div class="photo-placeholder" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-heart" fill="url(#g-heart)"/></svg></div>';
  const photoHtml = (id, name) => {
    const src = photos.get(String(id));
    return src ? `<img src="${esc(src)}" alt="Foto del combo ${esc(name)}" decoding="async">` : placeholder;
  };

  function listMessage(title, text, withRetry = false) {
    $("admin-list").innerHTML = `<div class="status-card"><svg class="status-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-heart" fill="url(#g-heart)"/></svg><h3>${esc(title)}</h3><p>${esc(text)}</p>${withRetry ? '<button id="retry-load" class="btn btn-primary btn-small" type="button">Reintentar</button>' : ""}</div>`;
    $("retry-load")?.addEventListener("click", loadCombos);
  }

  /* ---------- Carga y pintado ---------- */
  async function loadCombos() {
    const token = ++loadToken;
    $("admin-list").innerHTML = `<div class="status-card"><svg class="mini-heart" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-heart" fill="url(#g-heart)"/></svg><h3>Cargando combos ♡</h3></div>`;
    try {
      let res = await withTimeout(sb.from("combos").select(LIGHT_COLUMNS));
      let missingCategory = false;
      if (res.error && /categoria/i.test(res.error.message || "")) {
        missingCategory = true;
        res = await withTimeout(sb.from("combos").select(LIGHT_COLUMNS_NO_CAT));
      }
      if (token !== loadToken) return;
      if (res.error) throw res.error;
      combos = res.data || [];
      if (missingCategory) toast("Falta ejecutar supabase.sql para crear la columna de categoría.", "error", 8000, { key: "load" });
      renderCombos();
      fillCategoryList();
      loadPhotos(token);
    } catch (error) {
      console.error(error);
      if (token !== loadToken) return;
      listMessage("No pudimos cargar los combos", error.message || "Revisa tu conexión.", true);
    }
  }

  /* Descarga las fotos de 3 en 3 y las va colocando en su tarjeta */
  async function loadPhotos(token) {
    const pending = combos.filter(c => !photos.has(String(c.id))).map(c => c.id);
    const worker = async () => {
      while (pending.length && token === loadToken) {
        const id = pending.shift();
        try {
          const { data } = await withTimeout(sb.from("combos").select("foto").eq("id", id).maybeSingle(), 30000);
          photos.set(String(id), data?.foto || null);
          const box = document.querySelector(`.admin-photo[data-photo="${CSS.escape(String(id))}"]`);
          const combo = combos.find(c => String(c.id) === String(id));
          if (box && combo) box.innerHTML = photoHtml(id, combo.nombre);
        } catch (error) { console.warn("No se pudo cargar una foto:", error); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  function fillCategoryList() {
    const names = groupByCategory(combos).map(g => g.name).filter(n => n !== "Sin categoría");
    $("category-list").innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join("");
  }

  function comboHtml(combo) {
    return `<article class="admin-combo">
      <div class="admin-photo" data-photo="${esc(combo.id)}">${photoHtml(combo.id, combo.nombre)}</div>
      <div class="admin-combo-body">
        <h3>${esc(combo.nombre)}</h3>
        <p>${esc(combo.descripcion || DEFAULT_DESC)}</p>
        <div class="admin-meta">
          <span class="price">${money(combo.precio)}</span>
          <span class="status-pill ${combo.activo ? "" : "off"}">${combo.activo ? "Visible" : "Oculto"}</span>
        </div>
        <div class="admin-card-actions">
          <button class="btn btn-primary" type="button" data-edit="${esc(combo.id)}">Editar</button>
          <button class="btn" type="button" data-toggle="${esc(combo.id)}">${combo.activo ? "Ocultar" : "Mostrar"}</button>
          <button class="btn btn-danger" type="button" data-delete="${esc(combo.id)}">Eliminar</button>
        </div>
      </div>
    </article>`;
  }

  /* Igual que en el sitio: categorías como subtítulo, todo alfabético */
  function renderCombos() {
    const list = $("admin-list");
    if (!combos.length) { listMessage("Aún no hay combos", "Agrega el primero con el botón “Agregar combo”."); return; }
    list.innerHTML = groupByCategory(combos).map(group => `
      <section aria-label="${esc(group.name)}">
        <h3 class="category-title">${esc(group.name)}</h3>
        <div class="admin-grid">${group.items.map(comboHtml).join("")}</div>
      </section>`).join("");
  }

  const findCombo = id => combos.find(c => String(c.id) === String(id));

  /* ---------- Formulario ---------- */
  async function openForm(combo = null) {
    editingId = combo?.id ?? null;
    $("combo-form").reset();
    $("combo-name").value = combo?.nombre ?? "";
    $("combo-category").value = combo?.categoria ?? "";
    $("combo-price").value = combo?.precio ?? "";
    $("combo-description").value = combo?.descripcion ?? DEFAULT_DESC;
    $("combo-active").checked = combo ? !!combo.activo : true;
    $("form-title").textContent = combo ? "Editar combo" : "Nuevo combo";
    $("btn-save").textContent = combo ? "Guardar cambios" : "Guardar combo";
    const preview = $("photo-preview");
    const cached = combo ? photos.get(String(combo.id)) : null;
    preview.src = cached || "";
    preview.style.display = cached ? "block" : "none";
    show($("form-panel"));
    $("form-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    $("combo-name").focus({ preventScroll: true });
    // Si la foto actual aún no llegó, se pide para mostrarla en la vista previa
    if (combo && !photos.has(String(combo.id))) {
      try {
        const { data } = await withTimeout(sb.from("combos").select("foto").eq("id", combo.id).maybeSingle(), 30000);
        photos.set(String(combo.id), data?.foto || null);
        if (editingId === combo.id && data?.foto && !$("combo-photo").files[0]) { preview.src = data.foto; preview.style.display = "block"; }
      } catch (error) { console.warn(error); }
    }
  }
  function closeForm() { editingId = null; hide($("form-panel")); }

  /* Reduce la imagen (máx. 900 px) y la comprime a WebP/JPEG */
  async function compressImage(file) {
    if (!file.type.startsWith("image/")) throw new Error("Selecciona un archivo de imagen válido.");
    if (file.size > 12 * 1024 * 1024) throw new Error("La foto es demasiado grande. Usa una imagen menor de 12 MB.");
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("No se pudo leer la imagen."));
        el.src = url;
      });
      const scale = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#EDE8F1";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      let out = "";
      for (const quality of [0.8, 0.65, 0.5, 0.4]) {
        out = canvas.toDataURL("image/webp", quality);
        if (!out.startsWith("data:image/webp")) out = canvas.toDataURL("image/jpeg", quality);
        if (out.length < 1_200_000) break;
      }
      if (out.length >= 1_400_000) throw new Error("La imagen sigue siendo muy pesada. Prueba con otra foto.");
      return out;
    } finally { URL.revokeObjectURL(url); }
  }

  async function previewSelectedImage() {
    const file = $("combo-photo").files[0];
    if (!file) return;
    try {
      const data = await compressImage(file);
      const preview = $("photo-preview");
      preview.src = data; preview.style.display = "block";
    } catch (error) {
      $("combo-photo").value = "";
      toast(error.message, "error", 4500, { key: "photo" });
    }
  }

  async function saveCombo(event) {
    event.preventDefault();
    const wasEditing = Boolean(editingId);
    const button = $("btn-save");
    const label = button.textContent;
    button.disabled = true; button.textContent = "Guardando…";
    try {
      if (!sb) throw new Error("No hay conexión con la base de datos (revisa config/env.js y tu internet).");
      const nombre = $("combo-name").value.trim();
      const categoria = $("combo-category").value.trim().replace(/\s+/g, " ");
      const precio = Number($("combo-price").value);
      const descripcion = $("combo-description").value.trim() || DEFAULT_DESC;
      if (nombre.length < 2 || nombre.length > 80) throw new Error("El nombre debe tener entre 2 y 80 caracteres.");
      if (categoria.length < 2 || categoria.length > 40) throw new Error("Escribe una categoría (entre 2 y 40 caracteres).");
      if (!Number.isFinite(precio) || precio < 0 || precio > 9999999) throw new Error("Escribe un precio válido.");
      if (descripcion.length > 300) throw new Error("La descripción no puede superar los 300 caracteres.");

      // Si ya existe esa categoría con otra capitalización, se reutiliza su escritura
      const known = groupByCategory(combos).find(g => g.name.toLowerCase() === categoria.toLowerCase() && g.name !== "Sin categoría");
      const payload = { nombre, categoria: known ? known.name : categoria, precio, descripcion, activo: $("combo-active").checked };

      // Al editar, la foto solo se envía si se eligió una nueva (así no se reescribe la anterior)
      const file = $("combo-photo").files[0];
      if (file) payload.foto = await compressImage(file);
      else if (!wasEditing) throw new Error("Selecciona una foto para el combo.");

      const result = wasEditing
        ? await sb.from("combos").update(payload).eq("id", editingId)
        : await sb.from("combos").insert(payload);
      if (result.error) throw result.error;

      if (payload.foto) photos.set(String(editingId), payload.foto);
      toast(wasEditing ? "Combo actualizado correctamente" : "Combo agregado correctamente", "success", 3000, { key: "save" });
      closeForm();
      await loadCombos();
    } catch (error) {
      toast(`No se pudo guardar: ${error.message}`, "error", 6000, { key: "save" });
    } finally {
      button.disabled = false; button.textContent = label;
    }
  }

  async function toggleCombo(id) {
    const combo = findCombo(id);
    if (!combo) return;
    const { error } = await sb.from("combos").update({ activo: !combo.activo }).eq("id", id);
    if (error) { toast(`No se pudo cambiar la visibilidad: ${error.message}`, "error", 5000, { key: "toggle" }); return; }
    toast(combo.activo ? "Combo oculto del catálogo" : "Combo visible en el catálogo", "success", 2500, { key: "toggle" });
    await loadCombos();
  }

  /* ---------- Eliminar ---------- */
  function openDeleteModal(id) {
    const combo = findCombo(id);
    if (!combo) return;
    deletingId = id;
    $("confirm-text").textContent = `¿Seguro que deseas eliminar “${combo.nombre}”? Esta acción no se puede deshacer.`;
    $("confirm-modal").classList.add("open");
    $("btn-cancel-delete").focus();
  }
  function closeDeleteModal() { deletingId = null; $("confirm-modal").classList.remove("open"); }

  async function deleteCombo() {
    if (!deletingId) return;
    const id = deletingId;
    const button = $("btn-confirm-delete");
    button.disabled = true; button.textContent = "Eliminando…";
    const { error } = await sb.from("combos").delete().eq("id", id);
    if (error) toast(`No se pudo eliminar: ${error.message}`, "error", 5000, { key: "delete" });
    else { photos.delete(String(id)); toast("Combo eliminado correctamente", "success", 2800, { key: "delete" }); await loadCombos(); }
    button.disabled = false; button.textContent = "Sí, eliminar";
    closeDeleteModal();
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    $("btn-nuevo").addEventListener("click", () => {
      try { openForm(); }
      catch (error) { console.error(error); show($("form-panel")); toast(`No se pudo preparar el formulario: ${error.message}`, "error", 5000, { key: "form" }); }
    });
    $("btn-cancel").addEventListener("click", closeForm);
    $("combo-photo").addEventListener("change", previewSelectedImage);
    $("combo-form").addEventListener("submit", saveCombo);
    $("btn-cancel-delete").addEventListener("click", closeDeleteModal);
    $("btn-confirm-delete").addEventListener("click", deleteCombo);
    $("confirm-modal").addEventListener("click", e => { if (e.target.id === "confirm-modal") closeDeleteModal(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeDeleteModal(); });
    $("admin-list").addEventListener("click", e => {
      const edit = e.target.closest("[data-edit]");
      const toggle = e.target.closest("[data-toggle]");
      const del = e.target.closest("[data-delete]");
      if (edit) openForm(findCombo(edit.dataset.edit));
      else if (toggle) toggleCombo(toggle.dataset.toggle);
      else if (del) openDeleteModal(del.dataset.delete);
    });

    if (!sb) {
      if (configured && !window.supabase) listMessage("No se pudo cargar Supabase", "La librería de Supabase no cargó. Revisa tu conexión a internet y recarga con Ctrl+F5.");
      else listMessage("Falta conectar la base de datos", "Agrega SUPABASE_URL y SUPABASE_KEY en config/env.js y recarga la página.");
      return;
    }
    loadCombos();
  });
})();
