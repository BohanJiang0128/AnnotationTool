# 3D Body Surface Annotation Tool

A browser-based server application for annotating 3D human body meshes and calculating **Body Surface Area (BSA)** percentages. Designed for medical researchers, dermatologists, and clinical annotators who need to precisely mark regions of interest on 3D human models.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Project Structure](#project-structure)
- [Setup & Installation](#setup--installation)
- [Running the Server](#running-the-server)
- [Usage Guide](#usage-guide)
- [User Management](#user-management)
- [Annotation Persistence](#annotation-persistence)
- [3D Models](#3d-models)

---

## Overview

The tool runs as a local web server (Flask) and is accessed through any modern browser. Multiple users can log in with individual credentials, each maintaining their own set of saved annotations independently.

The interface is split into four panels:

```
┌──────────────┬────────────────┬──────────────────────┬──────────────┐
│  Image List  │  Image Preview │     3D Viewer        │  3D Models   │
│              │                │  [Cursor] [Pen]      │              │
│  (directory  │  (selected     │  [Clear] [Calc BSA]  │  f_1.obj     │
│   browser)   │   image large) │                      │  f_2.obj     │
│              │                │   <Three.js canvas>  │  m_1.obj ... │
│  img1.jpg ▶  │                │                      │              │
│  img2.png    │                │                      │  [model info]│
└──────────────┴────────────────┴──────────────────────┴──────────────┘
```

---

## Interface and Features

### Authentication
- Login page with username and password
- Credentials checked against `config/whitelist.txt`
- Server-side sessions (logout button in header)
- Failed login shows an error message and prompts retry

### Image Viewer (Left Panels)
- **Directory input**: type or paste any server-side filesystem path, press Enter or click `→`
- **Image list**: all `.jpg`, `.jpeg`, and `.png` files in the directory are listed with thumbnail previews
- **Image preview**: clicking any image in the list shows it full-size in the adjacent panel

### 3D Model Viewer (Center Panel)
- Loads `.obj` files from the `assets/` folder using [Three.js](https://threejs.org/)
- Models are automatically centered and scaled to fill the viewport
- Realistic lighting (ambient + hemisphere + directional)
- Ground grid reference plane

#### Cursor Tool (default)
- **Left-click drag**: rotate / spin the model
- **Right-click drag**: pan the camera
- **Scroll wheel**: zoom in / out

#### Pen Tool
- **Left-click / drag**: paint triangles red on the mesh surface
- **Right-click / drag**: erase painted triangles (restore to skin color)
- A hint bar appears at the bottom of the canvas when Pen is active
- Switch back to Cursor tool at any time without losing annotations

#### BSA Calculator
- Click **Calculate BSA** to compute the **percentage of annotated surface area**
- Uses the actual 3D triangle geometry (cross-product area) — not a pixel approximation
- Formula: `annotated triangle area ÷ total mesh area × 100%`
- Result displayed live in the toolbar; triangle count shown in the model info box

#### Clear
- Resets all painted triangles back to the default skin color
- Also clears the BSA result display

### Annotation Persistence
- Annotations are automatically saved 800 ms after the last paint stroke (debounced)
- Each user's annotations are stored separately under `annotations/<username>/<model>.json`
- When a model is re-selected, saved annotations are automatically restored

---

## Project Structure

```
annotation_tool/
│
├── server.py                   # Flask backend (routes, auth, file serving)
│
├── config/
│   └── whitelist.txt           # Allowed users — one "username:password" per line
│
├── assets/
│   ├── f_1.obj                 # Female models (BMI-relative variants)
│   ├── f_2.obj
│   ├── f_3.obj
│   ├── f_4.obj
│   ├── f_5.obj
│   ├── m_1.obj                 # Male models
│   ├── m_2.obj
│   ├── m_3.obj
│   ├── m_4.obj
│   └── m_5.obj
│
├── annotations/                # Auto-created; per-user annotation data
│   └── <username>/
│       └── <model_name>.json   # Saved face indices per mesh
│
├── templates/
│   ├── login.html              # Login page
│   └── index.html              # Main application
│
└── static/
    ├── css/
    │   └── style.css           # Dark-mode UI styles
    └── js/
        ├── viewer3d.js         # Three.js 3D engine (ES module)
        └── main.js             # UI orchestration (ES module)
```

---

## Setup & Installation

### Prerequisites
- [Miniconda](https://docs.conda.io/en/latest/miniconda.html) or Anaconda
- A modern browser (Chrome, Firefox, Edge)
- Internet connection on first load (Three.js is fetched from CDN and then cached)

### Create the Conda Environment

An `environment.yml` is included in the project root. Run once to create the `3dannotation` environment:

```bash
cd annotation_tool
conda env create -f environment.yml
```

This installs **Python 3.11** and **Flask 3.x** into an isolated environment named `3dannotation`.

#### Verify the environment

```bash
conda activate 3dannotation
python -c "import flask; import importlib.metadata; print('Flask', importlib.metadata.version('flask'))"
# → Flask 3.1.3
```

#### Update the environment later

If `environment.yml` changes (e.g. new dependencies are added):

```bash
conda env update -f environment.yml --prune
```

#### Remove the environment

```bash
conda deactivate
conda env remove -n 3dannotation
```

---

## Running the Server

```bash
conda activate 3dannotation
python server.py
```

The server starts on **`http://localhost:5000`** (also accessible at your machine's LAN IP for other devices on the same network).

```
Starting Annotation Tool server at http://localhost:5000
 * Running on http://127.0.0.1:5000
 * Running on http://10.x.x.x:5000
```

Open `http://localhost:5000` in your browser — you will be redirected to the login page automatically.

To stop the server press `Ctrl+C`. To deactivate the environment afterwards:

```bash
conda deactivate
```

> **Note:** The server runs in debug/auto-reload mode by default. For a shared or production deployment, use a WSGI server such as `gunicorn`:
> ```bash
> pip install gunicorn
> gunicorn -w 2 -b 0.0.0.0:5000 "server:app"
> ```

---

## Usage Guide

### Step 1 — Log In
Enter a username and password from `config/whitelist.txt`. Invalid credentials show an error; try again.

### Step 2 — Load Reference Images *(optional)*
In the **Images** panel (far left):
1. Type a full server-side directory path into the path box (e.g. `/home/user/patient_photos`)
2. Press **Enter** or click **→**
3. All `.jpg`/`.png` images in that folder appear as a scrollable list
4. Click any image to view it full-size in the **Image Preview** panel

### Step 3 — Select a 3D Model
In the **3D Models** panel (far right), click any `.obj` file. The model loads into the 3D viewer (large files are ~11 MB; a progress bar is shown while loading).

### Step 4 — Annotate
1. Click **Pen** in the toolbar above the 3D canvas
2. **Left-click and drag** over the mesh to paint regions red
3. **Right-click and drag** to erase painted areas
4. Click **Cursor** to return to orbit mode (annotations remain)

### Step 5 — Calculate BSA
Click **Calculate BSA** to see what percentage of the total body surface has been annotated. The result appears in the toolbar and the model info box is updated with triangle counts.

### Step 6 — Annotations Auto-Save
800 ms after your last brush stroke the annotations are automatically saved to the server. The save-status badge confirms success. Next time you select the same model, your annotations reload automatically.

---

## User Management

Edit `config/whitelist.txt` — one entry per line, format `username:password`:

```
admin:admin123
annotator:annotate2024
guest:guest123
```

- Add a line to grant access to a new user
- Remove a line to revoke access (takes effect on next login attempt)
- No server restart required — the file is read on every login

Each user's annotations are stored independently under `annotations/<username>/`.

---

## Annotation Persistence

Annotation files are stored as compact JSON:

```json
{
  "meshes": {
    "0": [142, 143, 512, 513, 1024],
    "1": []
  },
  "model": "f_1.obj",
  "user": "admin",
  "savedAt": "2026-03-30T06:35:00Z"
}
```

- Keys under `"meshes"` are mesh indices (order of sub-meshes in the OBJ file)
- Values are arrays of triangle (face) indices that have been painted
- Files are written to `annotations/<username>/<model_name>.json`

---

## 3D Models

The `assets/` folder contains 10 gender-relative BMI human body meshes:

| File | Gender | Description |
|------|--------|-------------|
| `f_1.obj` | Female | BMI variant 1 |
| `f_2.obj` | Female | BMI variant 2 |
| `f_3.obj` | Female | BMI variant 3 |
| `f_4.obj` | Female | BMI variant 4 |
| `f_5.obj` | Female | BMI variant 5 |
| `m_1.obj` | Male   | BMI variant 1 |
| `m_2.obj` | Male   | BMI variant 2 |
| `m_3.obj` | Male   | BMI variant 3 |
| `m_4.obj` | Male   | BMI variant 4 |
| `m_5.obj` | Male   | BMI variant 5 |

Additional `.obj` files placed in `assets/` will automatically appear in the model selector on next page load.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Python 3 + Flask |
| 3D Rendering | Three.js r160 (WebGL) |
| OBJ Loading | Three.js `OBJLoader` |
| Orbit Controls | Three.js `OrbitControls` |
| Auth | Flask sessions + `whitelist.txt` |
| Frontend | Vanilla HTML5 / CSS3 / ES Modules |
| Persistence | Per-user JSON files on server disk |
