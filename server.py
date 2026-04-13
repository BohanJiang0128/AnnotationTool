from flask import (
    Flask, render_template, request, jsonify,
    session, redirect, url_for, send_from_directory, abort
)
import os
import json
import datetime
import argparse
from functools import wraps

app = Flask(__name__)
app.secret_key = 'annotation_tool_secret_key_7x9z2024'

BASE_DIR        = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR      = os.path.join(BASE_DIR, 'assets')
WHITELIST_FILE  = os.path.join(BASE_DIR, 'config', 'whitelist.txt')
ANNOTATIONS_DIR = os.path.join(BASE_DIR, 'annotations')
DATA_DIR        = os.path.join(BASE_DIR, 'data')
os.makedirs(ANNOTATIONS_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)


def load_whitelist():
    credentials = {}
    try:
        with open(WHITELIST_FILE, 'r') as f:
            for line in f:
                line = line.strip()
                if line and ':' in line:
                    username, password = line.split(':', 1)
                    credentials[username.strip()] = password.strip()
    except FileNotFoundError:
        pass
    return credentials


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'username' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '').strip()
        whitelist = load_whitelist()
        if username in whitelist and whitelist[username] == password:
            session['username'] = username
            return redirect(url_for('index'))
        else:
            error = 'Invalid username or password. Please try again.'
    return render_template('login.html', error=error)


@app.route('/logout')
def logout():
    session.pop('username', None)
    return redirect(url_for('login'))


@app.route('/')
@login_required
def index():
    return render_template('index.html', username=session.get('username'))


@app.route('/api/list-dir')
@login_required
def api_list_dir():
    path = request.args.get('path', '').strip()
    if not path:
        return jsonify({'error': 'No path provided', 'files': [], 'dirs': []}), 400
    try:
        abs_path = os.path.abspath(path)
        if not os.path.isdir(abs_path):
            return jsonify({'error': 'Directory not found', 'files': [], 'dirs': []}), 404
        files, dirs = [], []
        for entry in sorted(os.scandir(abs_path), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.is_dir():
                dirs.append(entry.name)
            elif entry.is_file() and entry.name.lower().endswith(('.jpg', '.jpeg', '.png')):
                files.append(entry.name)
        parent = str(os.path.dirname(abs_path))
        return jsonify({'files': files, 'dirs': dirs, 'path': abs_path, 'parent': parent})
    except Exception as e:
        return jsonify({'error': str(e), 'files': [], 'dirs': []}), 500


@app.route('/api/image')
@login_required
def api_image():
    path = request.args.get('path', '').strip()
    try:
        abs_path = os.path.abspath(path)
        if not os.path.isfile(abs_path):
            abort(404)
        return send_from_directory(os.path.dirname(abs_path), os.path.basename(abs_path))
    except Exception:
        abort(404)


@app.route('/api/assets')
@login_required
def api_assets():
    try:
        files = sorted([f for f in os.listdir(ASSETS_DIR) if f.lower().endswith('.obj')])
        return jsonify({'files': files})
    except Exception as e:
        return jsonify({'error': str(e), 'files': []})


@app.route('/api/patients')
@login_required
def api_patients():
    try:
        dirs = [d.name for d in os.scandir(DATA_DIR) if d.is_dir()]
        dirs.sort()
        return jsonify({'patients': dirs})
    except Exception as e:
        return jsonify({'error': str(e), 'patients': []})


@app.route('/api/patients/<patient>/images')
@login_required
def api_patient_images(patient):
    try:
        patient_dir = os.path.join(DATA_DIR, os.path.basename(patient))
        if not os.path.isdir(patient_dir):
            return jsonify({'error': 'Patient directory not found', 'files': []}), 404
        
        files = []
        for entry in sorted(os.scandir(patient_dir), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.is_file() and entry.name.lower().endswith(('.jpg', '.jpeg', '.png')):
                files.append(entry.name)
        return jsonify({'files': files, 'path': patient_dir})
    except Exception as e:
        return jsonify({'error': str(e), 'files': []})


@app.route('/assets/<path:filename>')
@login_required
def serve_asset(filename):
    return send_from_directory(ASSETS_DIR, filename)


@app.route('/api/annotations/<folder>/<path:image_name>', methods=['GET'])
@login_required
def get_annotations(folder, image_name):
    username = session['username']
    # Sanitise: folder must be a simple name, no path traversal
    folder = os.path.basename(folder) or 'tmp'
    # image_name could be like 'img.jpg.json' so we safely join it
    filepath = os.path.join(ANNOTATIONS_DIR, username, folder, os.path.basename(image_name) + '.json')
    if not os.path.isfile(filepath):
        return jsonify({'meshes': {}}), 200
    try:
        with open(filepath, 'r') as f:
            return jsonify(json.load(f))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/annotations/<folder>/<path:image_name>', methods=['POST'])
@login_required
def save_annotations(folder, image_name):
    username = session['username']
    folder   = os.path.basename(folder) or 'tmp'
    user_dir = os.path.join(ANNOTATIONS_DIR, username, folder)
    os.makedirs(user_dir, exist_ok=True)
    filepath = os.path.join(user_dir, os.path.basename(image_name) + '.json')
    try:
        data = request.get_json(force=True)
        data['image']   = image_name
        data['folder']  = folder
        data['user']    = username
        data['savedAt'] = datetime.datetime.utcnow().isoformat() + 'Z'
        with open(filepath, 'w') as f:
            json.dump(data, f, separators=(',', ':'))
        return jsonify({'status': 'ok'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/patients/<patient>/metadata', methods=['GET', 'POST'])
@login_required
def api_patient_metadata(patient):
    username = session['username']
    patient = os.path.basename(patient) or 'tmp'
    user_dir = os.path.join(ANNOTATIONS_DIR, username, patient)
    os.makedirs(user_dir, exist_ok=True)
    filepath = os.path.join(user_dir, '_metadata.json')

    if request.method == 'POST':
        try:
            data = request.get_json(force=True)
            with open(filepath, 'w') as f:
                json.dump(data, f)
            return jsonify({'status': 'ok'})
        except Exception as e:
            return jsonify({'error': str(e)}), 500
    else:
        if not os.path.isfile(filepath):
            return jsonify({}), 200
        try:
            with open(filepath, 'r') as f:
                return jsonify(json.load(f))
        except Exception as e:
            return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='3D Annotation Tool Server')
    parser.add_argument('--port', type=int, default=5000,
                        help='Port to run the server on (default: 5000)')
    parser.add_argument('--host', type=str, default='127.0.0.1',
                        help='Host address to bind to (default: 127.0.0.1)')
    args = parser.parse_args()

    print(f"Starting Annotation Tool server at http://localhost:{args.port}")
    app.run(debug=True, host=args.host, port=args.port)
