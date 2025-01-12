import { Layer, ObjectCategory } from "@common/constants";
import { FlyoverPref } from "@common/definitions/obstacles";
import { PerkIds } from "@common/definitions/perks";
import { type ThrowableDefinition } from "@common/definitions/throwables";
import { CircleHitbox, Hitbox, HitboxType } from "@common/utils/hitbox";
import { Angle, Collision, CollisionResponse, Geometry, Numeric } from "@common/utils/math";
import { type FullData } from "@common/utils/objectsSerializations";
import { FloorTypes } from "@common/utils/terrain";
import { Vec, type Vector } from "@common/utils/vector";
import { type Game } from "../game";
import { type ThrowableItem } from "../inventory/throwableItem";
import { Building } from "./building";
import { BaseGameObject, type DamageParams, type GameObject } from "./gameObject";
import { Obstacle } from "./obstacle";
import { equalLayer } from "@common/utils/layer";

const enum Drag {
    Normal = 0.001,
    Harsh = 0.005
}

export class ThrowableProjectile extends BaseGameObject.derive(ObjectCategory.ThrowableProjectile) {
    override readonly fullAllocBytes = 4;
    override readonly partialAllocBytes = 12;

    private health?: number;

    readonly halloweenSkin: boolean;

    declare readonly hitbox: CircleHitbox;

    private _velocity = Vec.create(0, 0);

    tintIndex = 0;
    throwerTeamID = 0;

    get velocity(): Vector { return this._velocity; }
    set velocity(velocity: Partial<Vector>) {
        this._velocity.x = velocity.x ?? this._velocity.x;
        this._velocity.y = velocity.y ?? this._velocity.y;
    }

    private _angularVelocity = 0.0035;
    get angularVelocity(): number { return this._angularVelocity; }

    private readonly _spawnTime: number;

    /**
     * Grace period to prevent impact damage and collision logic
     * from instantly being applied to the grenade's owner
     */
    private _collideWithOwner = false;

    override get position(): Vector { return this.hitbox.position; }

    private _airborne = true;
    get airborne(): boolean { return this._airborne; }

    private _activated = false;
    get activated(): boolean { return this._activated; }

    private readonly _currentlyAbove = new Set<Obstacle | Building>();

    public static readonly squaredThresholds = Object.freeze({
        impactDamage: 0.0009 as number,
        flyover: 0.0009 as number,
        highFlyover: 0.0016 as number
    });

    private _currentDrag = Drag.Normal;

    /**
     * Every object gets an "invincibility tick" cause otherwise, throwables will
     * hit something, causing it to shrink, allowing the grenade to hit it again next tick,
     * leading to a chain reaction that can vaporize certain unlucky objects
     */
    private _damagedLastTick = new Set<GameObject>();

    constructor(
        game: Game,
        position: Vector,
        layer: Layer,
        readonly definition: ThrowableDefinition,
        readonly source: ThrowableItem,
        radius?: number
    ) {
        super(game, position);
        this.layer = layer;
        this._spawnTime = this.game.now;
        this.hitbox = new CircleHitbox(radius ?? 1, position);

        this.halloweenSkin = this.source.owner.perks.hasItem(PerkIds.PlumpkinBomb);

        // Colored Teammate C4s
        this.tintIndex = this.source.owner.colorIndex;
        if (this.source.owner.teamID) this.throwerTeamID = this.source.owner.teamID;

        for (const object of this.game.grid.intersectsHitbox(this.hitbox)) {
            this.handleCollision(object);
        }
        if (this.definition.c4) {
            this.source.owner.c4s.push(this);
            this.source.owner.dirty.activeC4s = true;
        }
        if (this.definition.health) this.health = this.definition.health;
    }

    push(angle: number, speed: number): void {
        this.velocity = Vec.add(this.velocity, Vec.fromPolar(angle, speed));
    }

    private _calculateSafeDisplacement(halfDt: number): Vector {
        let displacement = Vec.scale(this.velocity, halfDt);

        const displacementLength = Vec.length(displacement);
        const maxDisplacement = this.definition.speedCap * halfDt;

        if (displacementLength > maxDisplacement) {
            displacement = Vec.scale(displacement, maxDisplacement / displacementLength);
        }

        return displacement;
    }

    detonate(delay: number): void {
        this._activated = true;
        this.setPartialDirty();
        setTimeout(() => {
            if (this.dead) return;

            this.game.removeProjectile(this);

            const { explosion } = this.definition.detonation;

            const referencePosition = Vec.clone(this.position ?? this.source.owner.position);
            const game = this.game;

            if (explosion !== undefined) {
                game.addExplosion(
                    explosion,
                    referencePosition,
                    this.source.owner,
                    this.layer,
                    this.source
                );
            }
        }, delay);
    }

    update(): void {
        if (this.definition.c4) {
            this._airborne = false;
            return;
        }

        const halfDt = 0.5 * this.game.dt;

        const oldPosition = Vec.clone(this.hitbox.position);

        this.hitbox.position = Vec.add(this.hitbox.position, this._calculateSafeDisplacement(halfDt));

        this._velocity = { ...Vec.scale(this._velocity, 1 / (1 + this.game.dt * this._currentDrag)) };

        this.hitbox.position = Vec.add(this.hitbox.position, this._calculateSafeDisplacement(halfDt));

        this.rotation = Angle.normalize(this.rotation + this._angularVelocity * this.game.dt);

        const impactDamage = this.definition.impactDamage;
        const currentSquaredVel = Vec.squaredLength(this.velocity);
        const squaredThresholds = ThrowableProjectile.squaredThresholds;
        const remainAirborne = currentSquaredVel >= squaredThresholds.impactDamage;
        const shouldDealImpactDamage = impactDamage !== undefined && remainAirborne;

        if (!remainAirborne) {
            this._airborne = false;

            if (FloorTypes[this.game.map.terrain.getFloor(this.position, this.layer)].overlay) {
                this._currentDrag = Drag.Harsh;
            }
        }

        const flyoverCondMap = {
            [FlyoverPref.Always]: currentSquaredVel >= squaredThresholds.flyover,
            [FlyoverPref.Sometimes]: currentSquaredVel >= squaredThresholds.highFlyover,
            [FlyoverPref.Never]: false
        };

        const canFlyOver = (object: Building | Obstacle): boolean => {
            if (object.isObstacle) {
                /*
                    Closed doors can never be flown over
                */
                return object.door?.isOpen !== false && (
                    /*
                        If the obstacle is of a lower layer than this throwable, then the throwable can fly over it.
                        This allows throwables to go down stairs with ease.
                    */
                    object.layer < this.layer
                    /*
                        Otherwise, check conditions as normal
                    */
                    || flyoverCondMap[object.definition.allowFlyover]
                );
            } else {
                return flyoverCondMap[object.definition.allowFlyover];
            }
        };

        const damagedThisTick = new Set<GameObject>();

        let closestIntersection = {
            dist: Number.MAX_VALUE,
            position: Vec.create(0, 0),
            normal: Vec.create(0, 0),
            intersected: false,
            object: this as GameObject // temporary blehhhhhh
        };

        for (const object of this.game.grid.intersectsHitbox(this.hitbox, this.layer)) {
            const { isObstacle, isPlayer, isBuilding } = object;

            // ignore this object if…
            if (
                object.dead // …it's dead (duh)
                || ( // or…
                    (
                        !(isObstacle || isBuilding) // if it's neither an obstacle nor a building
                        || !object.collidable // or if it's not collidable
                        || !object.hitbox // or if it doesn't have a hitbox
                    )
                    && (
                        !isPlayer // and it's not a player
                        || !shouldDealImpactDamage // or impact damage isn't active
                        || (!this._collideWithOwner && object === this.source.owner) // or collisions with owner are off
                    )
                )
            ) continue;

            // do a little cfa above to see why the conditional does filter out null-ish hitboxes (left as an exercise to the reader)
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const hitbox = object.hitbox!;

            const lineIntersection = hitbox.intersectsLine(oldPosition, this.position);

            const isGeometricCollision = this.hitbox.collidesWith(hitbox);

            const collidingWithObject = lineIntersection || isGeometricCollision;

            if (isObstacle || isBuilding) {
                if (collidingWithObject) {
                    const isAbove = canFlyOver(object);
                    if (isAbove) {
                        this._currentlyAbove.add(object);
                    } else {
                        this._currentDrag = Drag.Harsh;
                    }

                    if (object.isObstacle && object.definition.isStair) {
                        object.handleStairInteraction(this);
                        continue;
                    }
                    if (isAbove || this._currentlyAbove.has(object)) {
                        continue;
                    }
                }
                this._currentlyAbove.delete(object);
            }

            if (lineIntersection) {
                const dist = Geometry.distanceSquared(oldPosition, lineIntersection.point);
                if (dist < closestIntersection.dist) {
                    closestIntersection = {
                        dist,
                        position: lineIntersection.point,
                        normal: lineIntersection.normal,
                        intersected: true,
                        object
                    };
                }
            }

            if (!collidingWithObject) continue;

            if (shouldDealImpactDamage && !this._damagedLastTick.has(object)) {
                object.damage({
                    amount: impactDamage * ((isObstacle ? this.definition.obstacleMultiplier : undefined) ?? 1),
                    source: this.source.owner,
                    weaponUsed: this.source
                });

                if (object.dead) {
                    continue;
                }

                damagedThisTick.add(object);
            }

            this.handleCollision(object);

            this._angularVelocity *= 0.6;
        }

        const selfRadius = this.hitbox.radius;

        if (closestIntersection.intersected) {
            this.hitbox.position = Vec.add(
                Vec.scale(closestIntersection.normal, selfRadius),
                this.hitbox.position
            );
            this.handleCollision(closestIntersection.object);
        }

        this.position.x = Numeric.clamp(this.position.x, selfRadius, this.game.map.width - selfRadius);
        this.position.y = Numeric.clamp(this.position.y, selfRadius, this.game.map.height - selfRadius);

        this._collideWithOwner ||= this.game.now - this._spawnTime >= 250;
        this._damagedLastTick = damagedThisTick;
        this.game.grid.updateObject(this);
        this.setPartialDirty();
    }

    handleCollision(object: GameObject): void {
        const { isObstacle, isPlayer, isBuilding } = object;

        // bail early if…
        if (
            object.dead // the object is dead
            || ( // or
                (
                    !(isObstacle || isBuilding) // it's neither an obstacle nor building
                    || (isObstacle && object.definition.isStair) // or it's a stair
                    || !object.collidable // or it's not collidable
                    || !object.hitbox // or it has not hitbox
                )
                && ( // and
                    !isPlayer // it's not a player
                    || (!this._collideWithOwner && object === this.source.owner) // or owner collision is off
                )
            )
        ) return;

        // nna could be used here, but there's a cleaner way to get rid of undefined with the optional chain below, so lol
        const hitbox = object.hitbox;

        if (!hitbox?.collidesWith(this.hitbox) || !equalLayer(this.layer, object.layer)) return;

        const handleCollision = (hitbox: Hitbox): CollisionResponse => {
            let collision: CollisionResponse = null;
            switch (hitbox.type) {
                case HitboxType.Circle:
                    collision = Collision.circleCircleIntersection(
                        hitbox.position,
                        hitbox.radius,
                        this.position,
                        this.hitbox.radius
                    );
                    break;
                case HitboxType.Rect:
                    collision = Collision.rectCircleIntersection(hitbox.min, hitbox.max, this.position, this.hitbox.radius);
                    if (collision) {
                        collision.dir.x = -collision.dir.x;
                        collision.dir.y = -collision.dir.y;
                    }
                    break;
                case HitboxType.Polygon:
                    collision = Collision.circlePolygonIntersection(
                        this.position,
                        this.hitbox.radius,
                        hitbox.center,
                        hitbox.points,
                        hitbox.normals
                    );
                    if (collision) {
                        collision.dir.x = -collision.dir.x;
                        collision.dir.y = -collision.dir.y;
                    }
                    break;
                case HitboxType.Group: {
                    for (const target of hitbox.hitboxes) {
                        if (target.collidesWith(this.hitbox)) {
                            collision = handleCollision(target);
                        }
                    }
                    break;
                }
            }
            if (collision) {
                this.hitbox.position = Vec.add(
                    this.hitbox.position,
                    Vec.scale(
                        collision.dir,
                        collision.pen
                    )
                );
            }
            return collision;
        };
        const collision = handleCollision(hitbox);
        if (collision) {
            const len = Vec.length(this._velocity);
            const dir = Vec.scale(this._velocity, 1 / len);
            const normal = collision.dir;

            const dot = Vec.dotProduct(dir, normal);
            const newDir = Vec.add(Vec.scale(normal, dot * -2), dir);
            this._velocity = Vec.scale(newDir, len * 0.4);
        }
    }

    override damage({ amount }: DamageParams): void {
        if (!this.health) return;

        this.health = this.health - amount;
        if (this.health <= 0) {
            // use a Set instead
            this.source.owner.c4s.splice(this.source.owner.c4s.indexOf(this), 1);
            this.game.removeProjectile(this);
            this.source.owner.dirty.activeC4s = true;
        }
    }

    get data(): FullData<ObjectCategory.ThrowableProjectile> {
        return {
            position: this.position,
            rotation: this.rotation,
            layer: this.layer,
            airborne: this._airborne,
            activated: this._activated,
            throwerTeamID: this.throwerTeamID,
            full: {
                definition: this.definition,
                halloweenSkin: this.halloweenSkin,
                tintIndex: this.tintIndex
            }
        };
    }
}
