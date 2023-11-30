import { clamp, lerp } from "./math";
import { type Vector, v, vAdd, vClone, vDot, vLength, vLengthSqr, vMul, vNormalizeSafe, vPerp, vSub } from "./vector";

function delerp(t: number, a: number, b: number): number {
    return clamp((t - a) / (b - a), 0, 1);
}

function fmod(num: number, n: number): number {
    return num - Math.floor(num / n) * n;
}

function distToSegmentSq(p: Vector, a: Vector, b: Vector): number {
    const ab = vSub(b, a);
    const c = vDot(vSub(p, a), ab) / vDot(ab, ab);
    const d = vAdd(a, vMul(ab, clamp(c, 0, 1)));
    const e = vSub(d, p);
    return vDot(e, e);
}

function catmullRom(t: number, p0: number, p1: number, p2: number, p3: number): number {
    return 0.5 * (2 * p1 + t * (-p0 + p2) + t * t * (2 * p0 - 5 * p1 + 4 * p2 - p3) + t * t * t * (-p0 + 3 * p1 - 3 * p2 + p3));
}

function catmullRomDerivative(t: number, p0: number, p1: number, p2: number, p3: number): number {
    return 0.5 * (-p0 + p2 + 2 * t * (2 * p0 - 5 * p1 + 4 * p2 - p3) + 3 * t * t * (-p0 + 3 * p1 - 3 * p2 + p3));
}

export class Spline {
    points: Vector[] = [];
    arcLens: number[] = [];
    totalArcLen: number;

    constructor(points: Vector[]) {
        for (let i = 0; i < points.length; i++) {
            this.points.push(vClone(points[i]));
        }

        const arcLenSamples = points.length * 4;
        let cur = this.points[0];
        for (let _i = 0; _i <= arcLenSamples; _i++) {
            const t = _i / arcLenSamples;
            const next = this.getPos(t);
            const arcLenPrev = _i === 0 ? 0 : this.arcLens[_i - 1];
            this.arcLens[_i] = arcLenPrev + vLength(vSub(next, cur));
            cur = vClone(next);
        }
        this.totalArcLen = this.arcLens[this.arcLens.length - 1];
    }

    getPos(t: number): Vector {
        const { pt, p0, p1, p2, p3 } = this.getControlPoints(t);

        return {
            x: catmullRom(pt, p0.x, p1.x, p2.x, p3.x),
            y: catmullRom(pt, p0.y, p1.y, p2.y, p3.y)
        };
    }

    getTangent(t: number): Vector {
        const { pt, p0, p1, p2, p3 } = this.getControlPoints(t);

        return {
            x: catmullRomDerivative(pt, p0.x, p1.x, p2.x, p3.x),
            y: catmullRomDerivative(pt, p0.y, p1.y, p2.y, p3.y)
        };
    }

    getNormal(t: number): Vector {
        const tangent = this.getTangent(t);
        return vPerp(vNormalizeSafe(tangent, v(1, 0)));
    }

    getClosestTtoPoint(pos: Vector): number {
        // Find closest segment to pos
        let closestDistSq = Number.MAX_VALUE;
        let closestSegIdx = 0;
        for (let i = 0; i < this.points.length - 1; i++) {
            const distSq = distToSegmentSq(pos, this.points[i], this.points[i + 1]);
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                closestSegIdx = i;
            }
        }
        const idx0 = closestSegIdx;
        const idx1 = idx0 + 1;
        const s0 = this.points[idx0];
        const s1 = this.points[idx1];
        const seg = vSub(s1, s0);
        const t = clamp(vDot(vSub(pos, s0), seg) / vDot(seg, seg), 0, 1);
        const len = this.points.length - 1;
        const tMin = clamp((idx0 + t - 0.1) / len, 0, 1);
        const tMax = clamp((idx0 + t + 0.1) / len, 0, 1);

        // Refine closest point by testing near the closest segment point
        let nearestT = (idx0 + t) / len;
        let nearestDistSq = Number.MAX_VALUE;
        const kIter = 8;
        for (let _i2 = 0; _i2 <= kIter; _i2++) {
            const testT = lerp(_i2 / kIter, tMin, tMax);
            const testPos = this.getPos(testT);
            const testDistSq = vLengthSqr(vSub(testPos, pos));
            if (testDistSq < nearestDistSq) {
                nearestT = testT;
                nearestDistSq = testDistSq;
            }
        }

        // Refine by offsetting along the spline tangent
        const tangent = this.getTangent(nearestT);
        const tanLen = vLength(tangent);
        if (tanLen > 0.0) {
            const nearest = this.getPos(nearestT);
            const offset = vDot(tangent, vSub(pos, nearest)) / tanLen;
            const offsetT = nearestT + offset / (tanLen * len);
            if (vLengthSqr(vSub(pos, this.getPos(offsetT))) < vLengthSqr(vSub(pos, nearest))) {
                nearestT = offsetT;
            }
        }

        return nearestT;
    }

    getTfromArcLen(arcLen: number): number {
        arcLen = clamp(arcLen, 0, this.totalArcLen);

        let idx = 0;
        while (arcLen > this.arcLens[idx]) {
            idx++;
        }

        if (idx === 0) {
            return 0;
        }
        const arcT = delerp(arcLen, this.arcLens[idx - 1], this.arcLens[idx]);
        const arcCount = this.arcLens.length - 1;
        const t0 = (idx - 1) / arcCount;
        const t1 = idx / arcCount;
        return lerp(arcT, t0, t1);
    }

    getArcLen(t: number): number {
        t = clamp(t, 0, 1);
        const arcCount = this.arcLens.length - 1;
        const idx0 = Math.floor(t * arcCount);
        const idx1 = idx0 < arcCount - 1 ? idx0 + 1 : idx0;
        const arcT = fmod(t, 1 / arcCount) / (1 / arcCount);
        return lerp(arcT, this.arcLens[idx0], this.arcLens[idx1]);
    }

    getControlPoints(t: number): {
        pt: number
        p0: Vector
        p1: Vector
        p2: Vector
        p3: Vector
    } {
        const count = this.points.length;
        t = clamp(t, 0, 1);
        const i = ~~(t * (count - 1));
        const i1 = i === count - 1 ? i - 1 : i;
        const i2 = i1 + 1;
        const i0 = i1 > 0 ? i1 - 1 : i1;
        const i3 = i2 < count - 1 ? i2 + 1 : i2;

        return {
            pt: t * (count - 1) - i1,
            p0: this.points[i0],
            p1: this.points[i1],
            p2: this.points[i2],
            p3: this.points[i3]
        };
    }
}
