const form = document.getElementById("queue-form");
const urlInput = document.getElementById("url-input");
const statusText = document.getElementById("status-text");
const queueList = document.getElementById("queue-list");
const loadQualityBtn = document.getElementById("load-quality-btn");
const optionButtons = document.getElementById("option-buttons");
const defaultLoadButtonText = loadQualityBtn.textContent;
let openPreviewItemId = null;

const bulkTabMatchOptions = document.getElementById("bulk-tab-match-options");
const bulkUrlsInput = document.getElementById("bulk-urls-input");
const bulkLoadQualityBtn = document.getElementById("bulk-load-quality-btn");
const bulkQueueVideoBtn = document.getElementById("bulk-queue-video-btn");
const bulkQueueMp3Btn = document.getElementById("bulk-queue-mp3-btn");
const selectAllCheckbox = document.getElementById("select-all-queue");
const selectionCountEl = document.getElementById("selection-count");
const bulkDownloadBtn = document.getElementById("bulk-download-btn");
const bulkDeleteBtn = document.getElementById("bulk-delete-btn");

let lastQueueItems = [];
const selectedIds = new Set();

/** SQLite / JSON sometimes gives id as string; Set uses strict equality — normalize everywhere. */
function normalizeQueueId(value) {
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
}

function initTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const panels = {
    single: document.getElementById("panel-single"),
    bulk: document.getElementById("panel-bulk")
  };
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.tab;
      tabBtns.forEach((b) => {
        const on = b === btn;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      Object.entries(panels).forEach(([k, el]) => {
        if (!el) return;
        const on = k === key;
        el.classList.toggle("is-active", on);
        if (on) {
          el.removeAttribute("hidden");
        } else {
          el.setAttribute("hidden", "");
        }
      });
    });
  });
}

initTabs();

function closePreviewCard(card) {
  const previewHolder = card.querySelector(".preview-holder");
  const thumbImg = card.querySelector(".thumb");
  const thumbOverlay = card.querySelector(".thumb-overlay");
  const previewBtn = card.querySelector(".preview-btn");
  if (!previewHolder || previewHolder.classList.contains("hidden")) {
    return;
  }

  previewHolder.innerHTML = "";
  previewHolder.classList.add("hidden");
  if (thumbImg) thumbImg.classList.remove("hidden");
  if (thumbOverlay) thumbOverlay.classList.remove("hidden");
  if (previewBtn) {
    const mode = previewBtn.dataset.previewType || "video";
    previewBtn.textContent = mode === "audio" ? "Play Audio" : "Play Video";
  }
}

function closeAllOtherPreviews(activeCard) {
  const cards = document.querySelectorAll(".queue-item");
  for (const card of cards) {
    if (card !== activeCard) {
      closePreviewCard(card);
    }
  }
}

async function fetchQueue() {
  const res = await fetch("/api/queue");
  if (!res.ok) {
    throw new Error("Failed to fetch queue");
  }
  return res.json();
}

async function fetchQualities(url) {
  const res = await fetch("/api/formats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Could not fetch quality options");
  }
  return data;
}

async function addToQueue(url, payload) {
  const res = await fetch("/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, ...payload })
  });
  const data = await res.json();

  if (!res.ok) {
    if (res.status === 409 && data.existingItem) {
      throw new Error(
        `${data.error} Existing item #${data.existingItem.id} is ${statusLabel(data.existingItem.status)}.`
      );
    }
    throw new Error(data.error || "Could not add video");
  }
  return data;
}

function renderOptionButtons(url, data) {
  optionButtons.innerHTML = "";

  const videoOptions = Array.isArray(data.qualities) ? data.qualities : [];

  for (const quality of videoOptions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option-btn";
    btn.textContent = `Video ${quality.label}`;
    btn.onclick = async () => {
      try {
        statusText.textContent = `Adding video (${quality.label}) to queue...`;
        const item = await addToQueue(url, {
          downloadType: "video",
          qualityPreference: quality.value
        });
        statusText.textContent = `Added #${item.id} video ${quality.label}`;
        await refreshQueue(true);
      } catch (err) {
        statusText.textContent = err.message;
      }
    };
    optionButtons.appendChild(btn);
  }

  const mp3Btn = document.createElement("button");
  mp3Btn.type = "button";
  mp3Btn.className = "option-btn mp3";
  mp3Btn.textContent = "Audio MP3 (Best)";
  mp3Btn.onclick = async () => {
    try {
      statusText.textContent = "Adding MP3 to queue...";
      const item = await addToQueue(url, {
        downloadType: "mp3",
        qualityPreference: "best"
      });
      statusText.textContent = `Added #${item.id} MP3`;
      await refreshQueue(true);
    } catch (err) {
      statusText.textContent = err.message;
    }
  };
  optionButtons.appendChild(mp3Btn);
}

function renderBulkQualityOptions(data) {
  if (!bulkTabMatchOptions) return;
  bulkTabMatchOptions.innerHTML = "";
  bulkTabMatchOptions.classList.remove("hidden");
  const videoOptions = Array.isArray(data.qualities) ? data.qualities : [];
  const hint = document.createElement("span");
  hint.className = "bulk-quality-hint";
  hint.textContent = "Queue all lines in the list at:";
  bulkTabMatchOptions.appendChild(hint);

  for (const quality of videoOptions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option-btn";
    btn.textContent = `Video ${quality.label}`;
    btn.onclick = async () => {
      try {
        await runBulkQueue(quality.value, "video");
      } catch (err) {
        statusText.textContent = err.message;
      }
    };
    bulkTabMatchOptions.appendChild(btn);
  }

  const mp3Bulk = document.createElement("button");
  mp3Bulk.type = "button";
  mp3Bulk.className = "option-btn mp3";
  mp3Bulk.textContent = "Audio MP3 (Best)";
  mp3Bulk.onclick = async () => {
    try {
      await runBulkQueue("best", "mp3");
    } catch (err) {
      statusText.textContent = err.message;
    }
  };
  bulkTabMatchOptions.appendChild(mp3Bulk);
}

function statusLabel(status) {
  switch (status) {
    case "queued":
      return "Queued";
    case "downloading":
      return "Downloading";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

async function queueAction(id, action) {
  const res = await fetch(`/api/queue/${id}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Action failed");
  }
  return data;
}

function askRemoveMode() {
  const deleteFileToo = window.confirm(
    "Do you also want to delete the associated downloaded file from disk?\n\nOK = Remove from app + delete file\nCancel = Remove from app only"
  );
  return { deleteFileToo };
}

function parseBulkUrlLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

async function queueUrlsBulk(urls, qualityPreference, downloadType) {
  if (!urls.length) {
    statusText.textContent = "No videos / URLs selected.";
    return;
  }
  statusText.textContent = `Adding ${urls.length} item(s) to queue...`;
  const res = await fetch("/api/queue/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: urls.map((url) => ({ url, qualityPreference, downloadType }))
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Bulk add failed");
  }
  const n = (data.created && data.created.length) || 0;
  const e = (data.errors && data.errors.length) || 0;
  if (e > 0) {
    const sample = data.errors
      .slice(0, 2)
      .map((x) => x.error || "error")
      .join("; ");
    statusText.textContent = `Queued ${n}, skipped ${e}.${sample ? ` Examples: ${sample}` : ""}`;
  } else {
    statusText.textContent = `Queued ${n} download(s).`;
  }
  await refreshQueue(true);
}

async function runBulkQueue(qualityPreference, downloadType) {
  if (!bulkUrlsInput) return;
  const lines = parseBulkUrlLines(bulkUrlsInput.value);
  if (lines.length === 0) {
    statusText.textContent = "Add one or more URLs in the list.";
    return;
  }
  await queueUrlsBulk(lines, qualityPreference, downloadType);
}

function syncSelectAllState() {
  if (!selectAllCheckbox) return;
  const boxes = [...document.querySelectorAll(".queue-select-cb:not([disabled])")];
  if (boxes.length === 0) {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.indeterminate = false;
    return;
  }
  const checkedCount = boxes.filter((b) => b.checked).length;
  selectAllCheckbox.checked = checkedCount === boxes.length;
  selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
}

function pruneSelectionToCurrentItems(items) {
  const currentIds = new Set();
  for (const i of items) {
    const qid = normalizeQueueId(i.id);
    if (qid != null) {
      currentIds.add(qid);
    }
  }
  for (const id of [...selectedIds]) {
    if (!currentIds.has(id)) {
      selectedIds.delete(id);
    }
  }
}

function updateToolbar() {
  if (!selectionCountEl || !bulkDownloadBtn || !bulkDeleteBtn) return;
  const n = selectedIds.size;
  selectionCountEl.textContent = n > 0 ? `${n} selected` : "";
  bulkDeleteBtn.disabled = n === 0;
  const canBulkDownload = lastQueueItems.some((i) => {
    const qid = normalizeQueueId(i.id);
    return (
      qid != null &&
      selectedIds.has(qid) &&
      i.status === "completed" &&
      Boolean(i.downloadUrl)
    );
  });
  bulkDownloadBtn.disabled = !canBulkDownload;
}

function createQueueItem(item) {
  const wrapper = document.createElement("article");
  wrapper.className = `queue-item ${item.status === "completed" ? "is-complete" : "is-active"}`;

  const qid = normalizeQueueId(item.id);

  const titleText = item.title || item.url;
  const thumb = item.thumbnailUrl || "https://placehold.co/640x360/101a33/c8d5ff?text=No+Thumbnail";

  const canPreview = item.status === "completed" && Boolean(item.downloadUrl);
  const isAudio = item.downloadType === "mp3";

  wrapper.innerHTML = `
    <div class="thumb-wrap">
      <label class="card-select-label" title="Select for bulk actions">
        <input type="checkbox" class="queue-select-cb" data-item-id="${qid != null ? qid : ""}" ${qid == null ? "disabled" : ""} />
      </label>
      <img class="thumb" src="${thumb}" alt="${titleText}" loading="lazy" />
      <div class="thumb-overlay">${item.progress || 0}%</div>
      ${canPreview ? `<button class="preview-btn">${isAudio ? "Play Audio" : "Play Video"}</button>` : ""}
      <div class="preview-holder hidden"></div>
    </div>
    <div class="card-body">
      <div>
        <div class="title">${titleText}</div>
        <div class="meta">#${item.id} - ${statusLabel(item.status)}</div>
        <div class="meta">${item.message}</div>
        <div class="meta">Quality: ${item.qualityPreference === "best" ? "Auto (Best)" : `${item.qualityPreference}p`}</div>
        <div class="meta">Type: ${item.downloadType || "video"}</div>
      </div>
    </div>
    <div class="progress-wrapper">
      <div class="progress-bar" style="width:${item.progress || 0}%"></div>
    </div>
    <div class="actions"></div>
  `;

  const selectCb = wrapper.querySelector(".queue-select-cb");
  if (selectCb && qid != null) {
    selectCb.checked = selectedIds.has(qid);
    selectCb.addEventListener("change", () => {
      const sid = normalizeQueueId(selectCb.dataset.itemId);
      if (sid == null) {
        return;
      }
      if (selectCb.checked) {
        selectedIds.add(sid);
      } else {
        selectedIds.delete(sid);
      }
      syncSelectAllState();
      updateToolbar();
    });
  }

  const actions = wrapper.querySelector(".actions");
  const previewBtn = wrapper.querySelector(".preview-btn");
  const previewHolder = wrapper.querySelector(".preview-holder");
  const thumbImg = wrapper.querySelector(".thumb");
  const thumbOverlay = wrapper.querySelector(".thumb-overlay");

  if (item.status !== "downloading") {
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn btn-remove";
    removeBtn.innerHTML = "<span class=\"btn-icon\">🗑</span><span>Remove</span>";
    removeBtn.onclick = async () => {
      try {
        const { deleteFileToo } = askRemoveMode();
        const res = await fetch(`/api/queue/${item.id}?deleteFile=${deleteFileToo ? "true" : "false"}`, {
          method: "DELETE"
        });
        if (!res.ok) {
          let errorMessage = "Could not remove item.";
          try {
            const data = await res.json();
            errorMessage = data.error || errorMessage;
          } catch (_err) {
            // ignore json parse failure
          }
          throw new Error(errorMessage);
        }
        statusText.textContent = deleteFileToo
          ? "Removed item and deleted associated file."
          : "Removed item from app.";
        await refreshQueue(true);
      } catch (err) {
        statusText.textContent = err.message;
      }
    };
    actions.appendChild(removeBtn);
  }

  if (item.status === "downloading") {
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-cancel";
    cancelBtn.innerHTML = "<span class=\"btn-icon\">✖</span><span>Cancel</span>";
    cancelBtn.onclick = async () => {
      try {
        await queueAction(item.id, "cancel");
        await refreshQueue(true);
      } catch (err) {
        statusText.textContent = err.message;
      }
    };
    actions.appendChild(cancelBtn);
  }

  if (item.status === "completed" && item.downloadUrl) {
    const link = document.createElement("a");
    link.className = "btn btn-download";
    link.href = item.downloadUrl;
    link.innerHTML = "<span class=\"btn-icon\">⬇</span><span>Download Only</span>";
    link.download = item.filename || "";
    actions.appendChild(link);
  }

  if (previewBtn && previewHolder) {
    previewBtn.dataset.previewType = isAudio ? "audio" : "video";
    previewBtn.onclick = () => {
      const showingPreview = !previewHolder.classList.contains("hidden");
      if (showingPreview) {
        closePreviewCard(wrapper);
        openPreviewItemId = null;
        return;
      }

      if (isAudio) {
        previewHolder.innerHTML = `
          <div class="audio-preview">
            <div class="audio-title">Audio Preview</div>
            <audio controls preload="metadata" src="${item.downloadUrl}"></audio>
          </div>
        `;
      } else {
        previewHolder.innerHTML = `
          <video controls preload="metadata" src="${item.downloadUrl}" poster="${thumb}"></video>
        `;
      }

      previewHolder.classList.remove("hidden");
      thumbImg.classList.add("hidden");
      thumbOverlay.classList.add("hidden");
      previewBtn.textContent = "Hide Preview";
      openPreviewItemId = item.id;
      closeAllOtherPreviews(wrapper);
      const media = previewHolder.querySelector("video, audio");
      if (media) {
        media.addEventListener("play", () => closeAllOtherPreviews(wrapper));
        media.play().catch(() => {});
      }
    };
  }

  return wrapper;
}

async function refreshQueue(force = false) {
  if (!force && openPreviewItemId !== null) {
    return;
  }

  try {
    const items = await fetchQueue();
    lastQueueItems = items;
    pruneSelectionToCurrentItems(items);
    queueList.innerHTML = "";

    if (items.length === 0) {
      queueList.innerHTML = "<p>No videos in queue.</p>";
      syncSelectAllState();
      updateToolbar();
      return;
    }

    for (const item of items) {
      queueList.appendChild(createQueueItem(item));
    }
    syncSelectAllState();
    updateToolbar();
  } catch (err) {
    statusText.textContent = err.message;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
});

loadQualityBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) {
    statusText.textContent = "Please paste YouTube URL first.";
    return;
  }

  optionButtons.innerHTML = "";
  optionButtons.innerHTML = "<span class=\"loading-chip\">Loading options...</span>";
  statusText.textContent = "Fetching latest options for this URL...";
  loadQualityBtn.disabled = true;
  loadQualityBtn.textContent = "Loading...";
  loadQualityBtn.classList.add("is-loading");
  try {
    const data = await fetchQualities(url);
    renderOptionButtons(url, data);
    statusText.textContent = data.title
      ? `Options loaded for: ${data.title}. Click any button to queue.`
      : "Options loaded. Click any button to queue.";
  } catch (err) {
    statusText.textContent = err.message;
    optionButtons.innerHTML = "";
  } finally {
    loadQualityBtn.disabled = false;
    loadQualityBtn.textContent = defaultLoadButtonText;
    loadQualityBtn.classList.remove("is-loading");
  }
});

if (selectAllCheckbox) {
  selectAllCheckbox.addEventListener("change", () => {
    const boxes = [...document.querySelectorAll(".queue-select-cb:not([disabled])")];
    if (selectAllCheckbox.checked) {
      for (const b of boxes) {
        const sid = normalizeQueueId(b.dataset.itemId);
        if (sid == null) {
          continue;
        }
        b.checked = true;
        selectedIds.add(sid);
      }
    } else {
      for (const b of boxes) {
        const sid = normalizeQueueId(b.dataset.itemId);
        if (sid != null) {
          selectedIds.delete(sid);
        }
        b.checked = false;
      }
    }
    syncSelectAllState();
    updateToolbar();
  });
}

if (bulkLoadQualityBtn && bulkUrlsInput) {
  bulkLoadQualityBtn.addEventListener("click", async () => {
    const lines = parseBulkUrlLines(bulkUrlsInput.value);
    const url = lines[0];
    if (!url) {
      statusText.textContent = "Add at least one URL in the list (first line is used for quality list).";
      return;
    }
    bulkLoadQualityBtn.disabled = true;
    bulkLoadQualityBtn.textContent = "Loading...";
    try {
      const data = await fetchQualities(url);
      renderBulkQualityOptions(data);
      statusText.textContent = data.title
        ? `Quality options from: ${data.title}. Use chips to queue all lines.`
        : "Quality options loaded.";
    } catch (err) {
      statusText.textContent = err.message;
      if (bulkTabMatchOptions) {
        bulkTabMatchOptions.innerHTML = "";
        bulkTabMatchOptions.classList.add("hidden");
      }
    } finally {
      bulkLoadQualityBtn.disabled = false;
      bulkLoadQualityBtn.textContent = "Load quality options (first URL in list)";
    }
  });
}

if (bulkQueueVideoBtn) {
  bulkQueueVideoBtn.addEventListener("click", async () => {
    try {
      await runBulkQueue("best", "video");
    } catch (err) {
      statusText.textContent = err.message;
    }
  });
}

if (bulkQueueMp3Btn) {
  bulkQueueMp3Btn.addEventListener("click", async () => {
    try {
      await runBulkQueue("best", "mp3");
    } catch (err) {
      statusText.textContent = err.message;
    }
  });
}

if (bulkDeleteBtn) {
  bulkDeleteBtn.addEventListener("click", async () => {
    if (selectedIds.size === 0) {
      statusText.textContent = "Select at least one queue card (checkbox), then Remove selected.";
      return;
    }
    const { deleteFileToo } = askRemoveMode();
    const idsToSend = [...selectedIds].filter((id) => normalizeQueueId(id) != null);
    if (idsToSend.length === 0) {
      statusText.textContent = "Invalid selection. Refresh the page and try again.";
      return;
    }
    try {
      const res = await fetch("/api/queue/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: idsToSend,
          deleteFile: deleteFileToo
        })
      });
      const raw = await res.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch (_e) {
        throw new Error("Server returned invalid response. Restart the app and try again.");
      }
      if (!res.ok) {
        throw new Error(data.error || "Bulk remove failed");
      }
      const skipped = (data.skipped && data.skipped.length) || 0;
      const removed = (data.removed && data.removed.length) || 0;
      if (removed === 0 && skipped === 0) {
        statusText.textContent =
          "Nothing was removed (no valid IDs reached the server). Refresh and select again.";
      } else if (skipped > 0) {
        statusText.textContent = `Removed ${removed}. Skipped ${skipped} (e.g. still downloading — cancel those first).`;
      } else {
        statusText.textContent = deleteFileToo
          ? `Removed ${removed} item(s) and deleted files where applicable.`
          : `Removed ${removed} item(s) from the app.`;
      }
      selectedIds.clear();
      if (selectAllCheckbox) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
      }
      await refreshQueue(true);
    } catch (err) {
      statusText.textContent = err.message;
    }
  });
}

if (bulkDownloadBtn) {
  bulkDownloadBtn.addEventListener("click", () => {
    const completed = lastQueueItems.filter((i) => {
      const qid = normalizeQueueId(i.id);
      return (
        qid != null &&
        selectedIds.has(qid) &&
        i.status === "completed" &&
        i.downloadUrl
      );
    });
    if (completed.length === 0) {
      statusText.textContent = "No completed files in selection.";
      return;
    }
    let delay = 0;
    for (const item of completed) {
      const href = item.downloadUrl;
      const fname = item.filename || "";
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = href;
        a.download = fname;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, delay);
      delay += 450;
    }
    statusText.textContent = `Started ${completed.length} browser download(s).`;
  });
}

setInterval(refreshQueue, 1500);
refreshQueue();
