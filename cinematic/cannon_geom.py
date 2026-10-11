"""The Mark 50 forearm cannon's hull, as numbers (numpy only: used by the tracing scripts and by build_cannon.py).

Model frame: long axis +Y from y=0 (root, at the elbow) to y=1 (tip of the upper jaw); X across; +Z up (the top, the
side the Monkey Depot photo looks down on). Length 1.

The hull is a loft of superellipse sections: at each y a top z_t(y), a bottom z_b(y), a half width w(y) and an
exponent n; the root end is capped by an elliptical dome. One surface carries everything; it is split into
  upper: root to throat all round, then the upper jaw (the hood: the section above the upper rim line), and
  lower: the lower jaw, the section below the lower rim line from the throat to its tip, swung down about a hinge.
Points on the surface are named (u, v): u = y, v = arc length round the section from the top centre line, + towards
+X (so v = +-S(u), S the half perimeter, is the bottom centre line).  P(u, v) is the point, N(u, v) the outward
normal; a panel traced in (u, v) is laid on the hull by P + w N."""
import numpy as np

NT = 241    # (samples round the half section)
NU = 461    # (stations along the length)


def spline(xs, ys, x):
    """Catmull-Rom through the control points (xs ascending), clamped at the ends."""
    xs = np.asarray(xs, float)
    ys = np.asarray(ys, float)
    x = np.clip(np.asarray(x, float), xs[0], xs[-1])
    i = np.clip(np.searchsorted(xs, x, side='right') - 1, 0, len(xs) - 2)
    x0, x1 = xs[i], xs[i + 1]
    t = (x - x0) / (x1 - x0)
    p0 = ys[np.maximum(i - 1, 0)]
    p1, p2 = ys[i], ys[i + 1]
    p3 = ys[np.minimum(i + 2, len(xs) - 1)]
    # (tangents scaled for uneven spacing)
    xm = xs[np.maximum(i - 1, 0)]
    xp = xs[np.minimum(i + 2, len(xs) - 1)]
    m1 = (p2 - p0) / np.maximum(x1 - xm, 1e-9) * (x1 - x0)
    m2 = (p3 - p1) / np.maximum(xp - x0, 1e-9) * (x1 - x0)
    t2, t3 = t * t, t * t * t
    return (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2


def rot_x(deg):
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


class Hull:
    def __init__(self, D):
        self.D = D
        pr = D['profile']
        self.ymax = pr['y'][-1]
        self.u = np.linspace(0.0, self.ymax, NU)
        self.zt = spline(pr['y'], pr['zt'], self.u)
        self.zb = spline(pr['y'], pr['zb'], self.u)
        self.w = spline(pr['y'], pr['w'], self.u)
        self.n = spline(pr['y'], pr['n'], self.u) if isinstance(pr.get('n'), list) else np.full(NU, D.get('n', 2.8))
        cap = D['cap']
        f = np.ones(NU)
        k = self.u < cap
        f[k] = np.sqrt(np.maximum(1 - (1 - self.u[k] / cap) ** 2, 0)) * (1 - D.get('cap_flat', 0.0)) + \
            D.get('cap_flat', 0.0) * (self.u[k] > 0)
        f = np.maximum(f, 1e-4)
        zc = (self.zt + self.zb) / 2
        hh = (self.zt - self.zb) / 2 * f
        ww = self.w * f
        th = np.linspace(0, np.pi, 2001)                         # (top centre to bottom centre, +X side)
        s_, c_ = np.sin(th), np.cos(th)
        e = 2.0 / self.n[:, None]
        X = ww[:, None] * np.abs(s_)[None] ** e
        Z = zc[:, None] + hh[:, None] * np.sign(c_)[None] * np.abs(c_)[None] ** e
        d = np.sqrt(np.diff(X, axis=1) ** 2 + np.diff(Z, axis=1) ** 2)
        S = np.concatenate([np.zeros((NU, 1)), np.cumsum(d, axis=1)], axis=1)
        self.half = S[:, -1]                                     # (half perimeter at each station)
        self.t = np.linspace(0, 1, NT)
        self.X = np.empty((NU, NT))
        self.Z = np.empty((NU, NT))
        for i in range(NU):                                      # (resampled evenly in arc length)
            q = self.t * self.half[i]
            self.X[i] = np.interp(q, S[i], X[i])
            self.Z[i] = np.interp(q, S[i], Z[i])
        self.throat = D['throat']
        self.rim_u = D['rim']['y']
        self.rim_z = D['rim']['z']
        L = D['lower']
        self.lrim_u, self.lrim_z = L['rim']['y'], L['rim']['z']
        self.ltip = L['tip']
        self.hinge = np.array([0.0, self.throat, float(spline(self.lrim_u, self.lrim_z, self.throat))])
        self.open = L.get('open_deg', 0.0)

    # ---- the surface ----
    def _grid(self, u, v):
        u = np.asarray(u, float)
        v = np.asarray(v, float)
        fu = np.clip(u / self.ymax * (NU - 1), 0, NU - 1 - 1e-9)
        i0 = np.floor(fu).astype(int)
        a = fu - i0
        half = self.half[i0] * (1 - a) + self.half[i0 + 1] * a
        t = np.clip(np.abs(v) / np.maximum(half, 1e-9), 0, 1)
        ft = t * (NT - 1)
        j0 = np.clip(np.floor(ft).astype(int), 0, NT - 2)
        b = ft - j0

        def bil(A):
            return ((A[i0, j0] * (1 - b) + A[i0, j0 + 1] * b) * (1 - a) +
                    (A[i0 + 1, j0] * (1 - b) + A[i0 + 1, j0 + 1] * b) * a)
        x = bil(self.X) * np.sign(v + 1e-12)
        z = bil(self.Z)
        return np.stack([x, u, z], axis=-1)

    def P(self, u, v, part='upper'):
        p = self._grid(u, v)
        if part == 'lower' and self.open:
            p = self.swing(p)
        return p

    def swing(self, p):
        R = rot_x(-self.open)   # (jaw down: its tip turns towards -Z)
        return (p - self.hinge) @ R.T + self.hinge

    def N(self, u, v, part='upper', du=1e-3, dv=1e-3):
        u = np.asarray(u, float)
        v = np.asarray(v, float)
        pu = self._grid(u + du, v) - self._grid(u - du, v)
        pv = self._grid(u, v + dv) - self._grid(u, v - dv)
        n = np.cross(pu, pv)
        # (outward: away from the section's centre line)
        zc = (np.interp(u, self.u, self.zt) + np.interp(u, self.u, self.zb)) / 2
        p = self._grid(u, v)
        out = p - np.stack([np.zeros_like(u), u, zc], axis=-1)
        out[..., 1] = 0
        flip = np.sum(n * out, axis=-1) < 0
        n[flip] *= -1
        # (at the dome the outward lean is along -y)
        n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-12)
        if part == 'lower' and self.open:
            n = n @ rot_x(-self.open).T
        return n

    def S(self, u):
        return np.interp(u, self.u, self.half)

    def v_at_z(self, u, z):
        """Arc length from the top centre line to the point at height z on the +X side of the section at u."""
        u = np.atleast_1d(np.asarray(u, float))
        z = np.atleast_1d(np.asarray(z, float))
        out = np.empty_like(u)
        for k in range(len(u)):
            fu = np.clip(u[k] / self.ymax * (NU - 1), 0, NU - 1)
            i = int(round(fu))
            zz = self.Z[i]                                     # (decreasing from top to bottom)
            out[k] = np.interp(-z[k], -zz, self.t) * self.half[i]
        return out

    def rim_v(self, u):
        """v of the upper jaw's rim (the mouth's top edge) at u (>= throat)."""
        return self.v_at_z(u, spline(self.rim_u, self.rim_z, u))

    def lrim_v(self, u):
        return self.v_at_z(u, spline(self.lrim_u, self.lrim_z, u))

    # ---- domains (outlines in (u, v)) ----
    def upper_domain(self, step=0.005):
        """The upper part's outline in (u, v): all round to the throat, then the hood to the tip."""
        us = np.arange(0, self.throat + 1e-9, step)
        uj = np.arange(self.throat, 1.0 + 1e-9, step)
        right = [(u, self.S(u)) for u in us] + [(u, float(self.rim_v(u)[0])) for u in uj]
        pts = right + [(u, -v) for u, v in reversed(right)]
        return pts

    def lower_domain(self, step=0.004, nose=None):
        """The lower jaw's outline in (u, v) (+X half; the left is its mirror): from the rim down to the bottom
        centre line, its front end rounded in plan."""
        nose = nose or self.D['lower'].get('nose', 0.06)
        us = np.arange(self.throat, self.ltip + 1e-9, step)
        pts = [(u, float(self.lrim_v(u)[0])) for u in us]
        # (the rounded front: from the rim at ltip - nose... to the bottom centre at ltip)
        u0 = self.ltip - nose
        pts = [p for p in pts if p[0] <= u0]
        vr = float(self.lrim_v(u0)[0])
        for a in np.linspace(0, np.pi / 2, 16)[1:]:
            u = u0 + nose * np.sin(a)
            vb = self.S(u)
            v = vr + (vb - vr) * (1 - np.cos(a))
            pts.append((u, float(v)))
        back = [(u, float(self.S(u))) for u in reversed(np.arange(self.throat, self.ltip + 1e-9, step))]
        return pts + back
