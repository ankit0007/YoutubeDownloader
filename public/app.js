const form = document.getElementById("queue-form");
const urlInput = document.getElementById("url-input");
const statusText = document.getElementById("status-text");
const queueList = document.getElementById("queue-list");
const loadQualityBtn = document.getElementById("load-quality-btn");
const optionButtons = document.getElementById("option-buttons");
const defaultLoadButtonText = loadQualityBtn.textContent;
let openPreviewItemId = null;

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

function createQueueItem(item) {
  const wrapper = document.createElement("article");
  wrapper.className = `queue-item ${item.status === "completed" ? "is-complete" : "is-active"}`;

  const titleText = item.title || item.url;
  const thumb = item.thumbnailUrl || "https://placehold.co/640x360/101a33/c8d5ff?text=No+Thumbnail";

  const canPreview = item.status === "completed" && Boolean(item.downloadUrl);
  const isAudio = item.downloadType === "mp3";

  wrapper.innerHTML = `
    <div class="thumb-wrap">
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
    queueList.innerHTML = "";

    if (items.length === 0) {
      queueList.innerHTML = "<p>No videos in queue.</p>";
      return;
    }

    for (const item of items) {
      queueList.appendChild(createQueueItem(item));
    }
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

setInterval(refreshQueue, 1500);
refreshQueue();
