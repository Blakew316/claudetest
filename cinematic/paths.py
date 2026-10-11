"""Where the models and the motion clips are. In the cloud workspace: its copies (the light model proxies). On the Mac:
found by file name under ~/Downloads and ~/Desktop, including inside the zips they were downloaded in (a clip found
only in a zip is unpacked once into ~/Desktop/fight_render/clips). CINE_IRONMAN, CINE_THANOS and CINE_CLIPS (folders,
separated by ':') point elsewhere."""
import os
import re
import zipfile

CLOUD = '/tmp/claude-0/-home-user-claudetest/1ca86f98-efae-51e1-a103-bd6371f97c5d/scratchpad/'
IN_CLOUD = os.path.isdir(CLOUD) and not os.environ.get('CINE_FORCE_MAC')
OUT = os.path.expanduser('~/Desktop/fight_render')
MODEL_FILES = {'ironman': 'Iron Man MK85.blend', 'thanos': 'Thanos_Armored_V_Tex.blend'}


def roots():
    if os.environ.get('CINE_CLIPS'):
        return os.environ['CINE_CLIPS'].split(':')
    if IN_CLOUD:
        return [CLOUD + d for d in ('mixamo_new', 'mocap_zip', 'packs', 'archive4', 'nanozip')]
    return [os.path.expanduser('~/Downloads'), os.path.expanduser('~/Desktop')]


_files, _zips = None, None


def key(name):
    """A file name compared without case, spaces or underscores (uploads and downloads differ in those)."""
    return re.sub(r'[\s_]+', '', os.path.basename(name).lower())


def loose(name):
    """...and without a repeat download's ' (1)': the fallback when there is no exact match."""
    return re.sub(r'\(\d+\)(?=\.[^.]+$)', '', key(name))


def _index():
    """Every file under the search folders by lower-case name (first found wins), and every zip."""
    global _files, _zips
    if _files is None:
        _files, _zips = {}, []
        for r in roots():
            for d, dirs, fs in os.walk(r):
                dirs[:] = [x for x in dirs if x != '__MACOSX' and not x.startswith('.')]
                for f in fs:
                    p = os.path.join(d, f)
                    _files.setdefault(key(f), p)
                    _files.setdefault('~' + loose(f), p)
                    if f.lower().endswith('.zip'):
                        _zips.append(p)
    return _files, _zips


def _from_zip(zf, name, cache, match=key, depth=0):
    """Unpack `name` from a zip (or a zip inside it) into cache; returns its path or None."""
    for info in zf.infolist():
        base = os.path.basename(info.filename)
        if '__MACOSX' in info.filename or not base:
            continue
        if match(base) == match(name):
            os.makedirs(cache, exist_ok=True)
            out = os.path.join(cache, base)
            with zf.open(info) as src, open(out, 'wb') as dst:
                dst.write(src.read())
            return out
        if base.lower().endswith('.zip') and depth < 2 and info.file_size < 300e6:
            import io
            with zf.open(info) as src:
                inner = zipfile.ZipFile(io.BytesIO(src.read()))
            hit = _from_zip(inner, name, cache, match, depth + 1)
            if hit:
                return hit
    return None


def clip(name):
    """A motion clip by its file name ('Hook Punch.fbx')."""
    name = os.path.basename(name)
    files, zips = _index()
    if key(name) in files:
        return files[key(name)]
    cache = os.path.join(OUT, 'clips')
    cached = os.path.join(cache, name)
    if os.path.exists(cached):
        return cached
    for match in (key, loose):
        for z in zips:
            try:
                with zipfile.ZipFile(z) as zf:
                    hit = _from_zip(zf, name, cache, match)
            except (zipfile.BadZipFile, OSError):
                continue
            if hit:
                files[key(name)] = hit
                return hit
        if match is key and '~' + loose(name) in files:
            return files['~' + loose(name)]
    raise FileNotFoundError(f'motion clip not found: {name} (looked under {", ".join(roots())} and in their zips)')


def have_clip(name):
    try:
        clip(name)
        return True
    except FileNotFoundError:
        return False


def model(kind):
    """The model file: 'ironman' or 'thanos'."""
    env = os.environ.get('CINE_' + kind.upper())
    if env:
        return env
    if IN_CLOUD:
        return CLOUD + f'models/{kind}_proxy.blend'
    files, _ = _index()
    p = files.get(key(MODEL_FILES[kind]))
    if not p:
        raise FileNotFoundError(f'{MODEL_FILES[kind]} not found under {", ".join(roots())}')
    return p
