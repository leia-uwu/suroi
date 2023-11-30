import { intersection } from "greiner-hormann";
import { PolygonHitbox, type RectangleHitbox } from "./hitbox";
import { clamp } from "./math";
import { Spline } from "./spline";
import { type Vector, v, vAdd, vDot, vInvert, vLength, vLengthSqr, vMul, vPerp, vSub } from "./vector";

// Ray-Line and Ray-Polygon implementations from
// http://ahamnett.blogspot.com/2012/06/raypolygon-intersections.html
function rayLineIntersect(origin: Vector, direction: Vector, lineA: Vector, lineB: Vector): number | undefined {
    const segment = vSub(lineB, lineA);
    const segmentPerp = v(segment.y, -segment.x);
    const perpDotDir = vDot(direction, segmentPerp);

    // Parallel lines, no intersection
    if (Math.abs(perpDotDir) <= 0.000001) return undefined;

    const d = vSub(lineA, origin);

    // Distance of intersection along ray
    const t = vDot(segmentPerp, d) / perpDotDir;

    // Distance of intersection along line
    const s = vDot(v(direction.y, -direction.x), d) / perpDotDir;

    // If t is positive and s lies within the line it intersects; returns t
    return t >= 0 && s >= 0 && s <= 1 ? t : undefined;
}

/*
function vMinElems(a: Vector, b: Vector): Vector {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
}
function vMaxElems(a: Vector, b: Vector): Vector {
    return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
}
function clampPosToAabb(pos: Vector, aabb: RectangleHitbox): Vector {
    return vMinElems(vMaxElems(pos, aabb.min), aabb.max);
}*/

function rayPolygonIntersect(origin: Vector, direction: Vector, vertices: Vector[]): number | undefined {
    let t = Number.MAX_VALUE;

    let intersected = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const distance = rayLineIntersect(origin, direction, vertices[j], vertices[i]);
        if (distance !== undefined) {
            if (distance < t) {
                intersected = true;
                t = distance;
            }
        }
    }

    // Returns closest intersection
    return intersected ? t : undefined;
}

export class River {
    spline: Spline;
    waterWidth: number;
    shoreWidth: number;

    waterPoly: Vector[] = [];
    shorePoly: Vector[] = [];
    waterWidths: number[] = [];
    shoreWidths: number[] = [];

    constructor(splinePts: Vector[], riverWidth: number, otherRivers: River[], mapBounds: RectangleHitbox, polygonBounds: Vector[]) {
        this.spline = new Spline(splinePts);

        this.waterWidth = riverWidth;
        this.shoreWidth = clamp(riverWidth * 0.75, 8, 16);

        const mapExtent = vMul(vSub(mapBounds.max, mapBounds.min), 0.5);
        const mapCenter = vAdd(mapBounds.min, mapExtent);

        for (let _i2 = 0; _i2 < splinePts.length; _i2++) {
            const vert = splinePts[_i2];
            let norm = this.spline.getNormal(_i2 / (splinePts.length - 1));

            // If the endpoints are near the map boundary, adjust the
            // normal to be parallel to the map aabb at that point.
            // This gives the river polygon flat ends flush with the map bounds.
            let nearMapEdge = false;
            if (_i2 === 0 || _i2 === splinePts.length - 1) {
                const e = vSub(vert, mapCenter);
                let edgePos = v(0, 0);
                let edgeNorm = v(1, 0);
                if (Math.abs(e.x) > Math.abs(e.y)) {
                    edgePos = v(e.x > 0 ? mapBounds.max.x : mapBounds.min.x, vert.y);
                    edgeNorm = v(e.x > 0 ? 1 : -1, 0);
                } else {
                    edgePos = v(vert.x, e.y > 0 ? mapBounds.max.y : mapBounds.min.y);
                    edgeNorm = v(0, e.y > 0 ? 1 : -1);
                }
                if (vLengthSqr(vSub(edgePos, vert)) < 1) {
                    let perpNorm = vPerp(edgeNorm);
                    if (vDot(norm, perpNorm) < 0) {
                        perpNorm = vInvert(perpNorm);
                    }
                    norm = perpNorm;
                    nearMapEdge = true;
                }
            }

            let { waterWidth } = this;
            // Widen river near the endpoints

            const len = splinePts.length;
            const end = 2 * (Math.max(1 - _i2 / len, _i2 / len) - 0.5);
            waterWidth = (1 + end ** 3 * 1.5) * this.waterWidth;

            this.waterWidths.push(waterWidth);

            // Increase shoreWidth to match that of larger nearby rivers.
            // Also determine if we terminate within another river. If so,
            // we need to constain our ending water and shore points to be
            // within that rivers polygons.
            //
            // There's a bug with clipRayToPoly when this happens at the
            // map edges; avoid that with a explicit check for now.
            let { shoreWidth } = this;
            let boundingRiver = null;
            for (let j = 0; j < otherRivers.length; j++) {
                const river = otherRivers[j];
                const t = river.spline.getClosestTtoPoint(vert);
                const p = river.spline.getPos(t);
                const _len = vLength(vSub(p, vert));
                if (_len < river.waterWidth * 2) {
                    shoreWidth = Math.max(shoreWidth, river.shoreWidth);
                }
                if ((_i2 === 0 || _i2 === splinePts.length - 1) && _len < 1.5 && !nearMapEdge) {
                    boundingRiver = river;
                }
            }
            if (_i2 > 0) {
                shoreWidth = (this.shoreWidths[_i2 - 1] + shoreWidth) / 2;
            }
            this.shoreWidths.push(shoreWidth);
            shoreWidth += waterWidth;

            // Poly verts
            const clipRayToPoly = function clipRayToPoly(pt: Vector, dir: Vector, poly: Vector[]): Vector {
                const hitbox = new PolygonHitbox(...poly);
                const end = vAdd(pt, dir);
                if (!hitbox.isPointInside(end)) {
                    const _t = rayPolygonIntersect(pt, dir, poly);
                    if (_t) {
                        return vMul(dir, _t);
                    }
                }
                return dir;
            };

            let waterRayA = vMul(norm, waterWidth);
            let waterRayB = vMul(norm, -waterWidth);
            let shoreRayA = vMul(norm, shoreWidth);
            let shoreRayB = vMul(norm, -shoreWidth);

            if (boundingRiver) {
                waterRayA = clipRayToPoly(vert, waterRayA, boundingRiver.waterPoly);
                waterRayB = clipRayToPoly(vert, waterRayB, boundingRiver.waterPoly);
                shoreRayA = clipRayToPoly(vert, shoreRayA, boundingRiver.shorePoly);
                shoreRayB = clipRayToPoly(vert, shoreRayB, boundingRiver.shorePoly);
            }

            const waterPtA = vAdd(vert, waterRayA);
            const waterPtB = vAdd(vert, waterRayB);
            const shorePtA = vAdd(vert, shoreRayA);
            const shorePtB = vAdd(vert, shoreRayB);

            /*waterPtA = clampPosToAabb(waterPtA, mapBounds);
            waterPtB = clampPosToAabb(waterPtB, mapBounds);
            shorePtA = clampPosToAabb(shorePtA, mapBounds);
            shorePtB = clampPosToAabb(shorePtB, mapBounds);*/

            this.waterPoly.splice(_i2, 0, waterPtA);
            this.waterPoly.splice(this.waterPoly.length - _i2, 0, waterPtB);
            this.shorePoly.splice(_i2, 0, shorePtA);
            this.shorePoly.splice(this.shorePoly.length - _i2, 0, shorePtB);
        }

        this.waterPoly = intersection(this.waterPoly, polygonBounds)[0];
        this.shorePoly = intersection(this.shorePoly, polygonBounds)[0];
    }

    distanceToShore(pos: Vector): number {
        const t = this.spline.getClosestTtoPoint(pos);
        const dist = vLength(vSub(pos, this.spline.getPos(t)));
        return Math.max(this.waterWidth - dist, 0);
    }

    getWaterWidth(t: number): number {
        const count = this.spline.points.length;
        const idx = clamp(Math.floor(t * count), 0, count);
        return this.waterWidths[idx];
    }
}
