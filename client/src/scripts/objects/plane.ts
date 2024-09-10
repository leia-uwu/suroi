import { GameConstants, Layer, ZIndexes } from "../../../../common/src/constants";
import { adjacentOrEqualLayer as adjacentOrEqualLayer, getEffectiveZIndex } from "../../../../common/src/utils/layer";
import { Geometry } from "../../../../common/src/utils/math";
import { Vec, type Vector } from "../../../../common/src/utils/vector";
import { type Game } from "../game";
import { type GameSound } from "../managers/soundManager";
import { PIXI_SCALE } from "../utils/constants";
import { SuroiSprite } from "../utils/pixi";

export class Plane {
    readonly game: Game;

    readonly startPosition: Vector;
    readonly endPosition: Vector;
    readonly image: SuroiSprite;
    readonly sound: GameSound;

    readonly startTime = Date.now();

    static readonly maxDistanceSquared = (GameConstants.maxPosition * 2) ** 2;

    constructor(game: Game, startPosition: Vector, direction: number) {
        this.game = game;

        this.startPosition = startPosition;

        this.endPosition = Vec.add(
            this.startPosition,
            Vec.fromPolar(direction, GameConstants.maxPosition * 2)
        );

        this.image = new SuroiSprite("airdrop_plane")
            .setZIndex(ZIndexes.Gas + 1)
            .setRotation(direction)
            .setScale(4);

        this.sound = game.soundManager.play(
            "airdrop_plane",
            {
                position: startPosition,
                falloff: 0.5,
                maxRange: 256,
                dynamic: true
            }
        );

        game.camera.addObject(this.image);
    }

    update(): void {
        this.image.zIndex = getEffectiveZIndex(ZIndexes.BuildingsCeiling + 1, Layer.Floor1, this.game.layer);

        const position = this.sound.position = Vec.lerp(
            this.startPosition,
            this.endPosition,
            (Date.now() - this.startTime) / (GameConstants.airdrop.flyTime * 2)
        );

        this.image.setVPos(Vec.scale(position, PIXI_SCALE));

        if (Geometry.distanceSquared(position, this.startPosition) > Plane.maxDistanceSquared) {
            this.destroy();
            this.game.planes.delete(this);
        }

        if (this.game.layer && this.game.layer !== Layer.Floor1) {
            this.image.visible = adjacentOrEqualLayer(Layer.Ground, this.game.layer);
            this.sound.maxRange = adjacentOrEqualLayer(Layer.Ground, this.game.layer) ? 256 : 0;
        }
    }

    destroy(): void {
        this.image.destroy();
    }
}
