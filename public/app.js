const form = document.getElementById("queue-form");
const urlInput = document.getElementById("url-input");
const statusText = document.getElementById("status-text");
const queueList = document.getElementById("queue-list");

async function fetchQueue() {
  const res = await fetch("/api/queue");
  if (!res.ok) {
    throw new Error("Failed to fetch queue");
  }
  return res.json();
}

function statusLabel(status) {
  switch (status) {
    case "queued":
      return "Queued";
    case "downloading":
      return "Downloading";
    case "paused":
      return "Paused";
    case "merging":
      return "Merging";
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

function createQueueItem(item) {
  const wrapper = document.createElement("article");
  wrapper.className = "queue-item";

  const titleText = item.title || item.url;

  wrapper.innerHTML = `
    <div class="queue-top">
      <div>
        <div class="title">${titleText}</div>
        <div class="meta">#${item.id} - ${statusLabel(item.status)} - ${item.message}</div>
      </div>
      <div class="meta">${item.progress || 0}%</div>
    </div>
    <div class="progress-wrapper">
      <div class="progress-bar" style="width:${item.progress || 0}%"></div>
    </div>
    <div class="actions"></div>
  `;

  const actions = wrapper.querySelector(".actions");

  if (item.status !== "downloading") {
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn btn-remove";
    removeBtn.textContent = "Remove";
    removeBtn.onclick = async () => {
      await fetch(`/api/queue/${item.id}`, { method: "DELETE" });
      await refreshQueue();
    };
    actions.appendChild(removeBtn);
  }

  if (item.status === "downloading") {
    const pauseBtn = document.createElement("button");
    pauseBtn.className = "btn btn-pause";
    pauseBtn.textContent = "Pause";
    pauseBtn.onclick = async () => {
      try {
        await queueAction(item.id, "pause");
        await refreshQueue();
      } catch (err) {
        statusText.textContent = err.message;
      }
    };
    actions.appendChild(pauseBtn);
  }

  if (item.status === "paused") {
    const resumeBtn = document.createElement("button");
    resumeBtn.className = "btn btn-resume";
    resumeBtn.textContent = "Resume";
    resumeBtn.onclick = async () => {
      try {
        await queueAction(item.id, "resume");
        await refreshQueue();
      } catch (err) {
        statusText.textContent = err.message;
      }
    };
    actions.appendChild(resumeBtn);
  }

  if (item.status === "downloading" || item.status === "paused" || item.status === "merging") {
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = async () => {
      try {
        await queueAction(item.id, "cancel");
        await refreshQueue();
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
    link.textContent = "Download File";
    link.download = item.filename || "";
    actions.appendChild(link);
  }

  return wrapper;
}

async function refreshQueue() {
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) {
    return;
  }

  statusText.textContent = "Adding to queue...";

  try {
    const res = await fetch("/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Could not add video");
    }

    urlInput.value = "";
    statusText.textContent = `Added #${data.id} to queue`;
    await refreshQueue();
  } catch (err) {
    statusText.textContent = err.message;
  }
});

setInterval(refreshQueue, 1500);
refreshQueue();
