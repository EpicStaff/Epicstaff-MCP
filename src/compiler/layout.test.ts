import { describe, expect, it } from 'vitest';

import {
    BRANCH_GAP,
    CANVAS_START_X,
    CANVAS_START_Y,
    COMPONENT_VERTICAL_GAP,
    DT_EXTRA_HORIZONTAL_GAP,
    GRID_CELL_SIZE,
    HORIZONTAL_GAP,
    SIBLING_GAP,
    computeAutoArrangePositions,
    snapToGrid,
    type LayoutConnection,
    type LayoutNode,
} from './layout.js';

const SIZE = { width: 330, height: 60 };

function node(id: string, type: string, size: { width: number; height: number } | undefined = SIZE): LayoutNode {
    return { id, type, size };
}

function conn(sourceNodeId: string, targetNodeId: string, sourcePortRole = 'output'): LayoutConnection {
    return {
        sourceNodeId,
        targetNodeId,
        sourcePortId: `${sourceNodeId}_${sourcePortRole}`,
        targetPortId: `${targetNodeId}_input`,
    };
}

describe('spacing constants', () => {
    it('match the frontend values', () => {
        expect(GRID_CELL_SIZE).toBe(20);
        expect(HORIZONTAL_GAP).toBe(360);
        expect(DT_EXTRA_HORIZONTAL_GAP).toBe(100);
        expect(SIBLING_GAP).toBe(50);
        expect(BRANCH_GAP).toBe(70);
        expect(CANVAS_START_X).toBe(100);
        expect(CANVAS_START_Y).toBe(100);
        expect(COMPONENT_VERTICAL_GAP).toBe(500);
    });
});

describe('linear chain', () => {
    // Hand-computed from the constants:
    //   Center Y for every node = CANVAS_START_Y + 60/2 = 130; snapped port Y = 140; top-left y = 140 - 30 = 110.
    //   Layer X: 100, 100+330+360 = 790, 1480, 2170. Snapped: 100, 800, 1480, 2180.
    const nodes = [node('start', 'start'), node('a', 'python'), node('b', 'python'), node('end', 'end')];
    const connections = [conn('start', 'a'), conn('a', 'b'), conn('b', 'end')];

    it('places start→a→b→end at exact positions', () => {
        const positions = computeAutoArrangePositions(nodes, connections);
        expect(positions.get('start')).toEqual({ x: 100, y: 110 });
        expect(positions.get('a')).toEqual({ x: 800, y: 110 });
        expect(positions.get('b')).toEqual({ x: 1480, y: 110 });
        expect(positions.get('end')).toEqual({ x: 2180, y: 110 });
        expect(positions.size).toBe(4);
    });

    it('uses the frontend default size 330x60 when size is absent', () => {
        const sizeless = nodes.map((n) => ({ id: n.id, type: n.type }));
        const positions = computeAutoArrangePositions(sizeless, connections);
        expect(positions.get('start')).toEqual({ x: 100, y: 110 });
        expect(positions.get('end')).toEqual({ x: 2180, y: 110 });
    });
});

describe('branching (one parent, 3 children)', () => {
    it('distributes siblings with SIBLING_GAP + BRANCH_GAP between spans', () => {
        // p is root by zero in-degree. Subtree span of p = 3*60 + 2*(50+70) = 420.
        // p centerY = 100 + 420/2 = 310 → port 320 → y 290.
        // Children topY starts at 310 - 420/2 = 100:
        //   c1 cy 130 → y 110; c2 cy 310 → y 290; c3 cy 490 → port 500 → y 470.
        const nodes = [node('p', 'python'), node('c1', 'python'), node('c2', 'python'), node('c3', 'python')];
        const connections = [conn('p', 'c1'), conn('p', 'c2'), conn('p', 'c3')];

        const positions = computeAutoArrangePositions(nodes, connections);
        expect(positions.get('p')).toEqual({ x: 100, y: 290 });
        expect(positions.get('c1')).toEqual({ x: 800, y: 110 });
        expect(positions.get('c2')).toEqual({ x: 800, y: 290 });
        expect(positions.get('c3')).toEqual({ x: 800, y: 470 });

        // Uniform vertical rhythm: height + SIBLING_GAP + BRANCH_GAP = 180 between sibling tops.
        expect(positions.get('c2')!.y - positions.get('c1')!.y).toBe(60 + SIBLING_GAP + BRANCH_GAP);
        expect(positions.get('c3')!.y - positions.get('c2')!.y).toBe(60 + SIBLING_GAP + BRANCH_GAP);
    });
});

describe('decision-table node', () => {
    it('sorts children by condition port order and widens the following layer gap', () => {
        // Children are wired out of order (condition-3 first) — port sort keys must reorder
        // them so condition-1 is on top. The layer after the table gets DT_EXTRA_HORIZONTAL_GAP:
        //   layer1 x = 100 + 330 + 360 + 100 = 890 → snapped 900.
        const nodes = [node('dt', 'table'), node('c1', 'python'), node('c2', 'python'), node('c3', 'python')];
        const connections = [
            conn('dt', 'c3', 'decision-out-condition-3'),
            conn('dt', 'c1', 'decision-out-condition-1'),
            conn('dt', 'c2', 'decision-out-condition-2'),
        ];

        const positions = computeAutoArrangePositions(nodes, connections);
        expect(positions.get('dt')).toEqual({ x: 100, y: 290 });
        expect(positions.get('c1')).toEqual({ x: 900, y: 110 });
        expect(positions.get('c2')).toEqual({ x: 900, y: 290 });
        expect(positions.get('c3')).toEqual({ x: 900, y: 470 });
    });
});

describe('merge node (2 parents → 1 child)', () => {
    it('centers the child on the average of its parents', () => {
        // p1, p2 are zero-in-degree roots stacked with span+SIBLING_GAP+BRANCH_GAP:
        //   p1 cy 130 → y 110; p2 cy 310 → y 290.
        // m cy = (130 + 310) / 2 = 220 → port 220 → y 190.
        const nodes = [node('p1', 'python'), node('p2', 'python'), node('m', 'python')];
        const connections = [conn('p1', 'm'), conn('p2', 'm')];

        const positions = computeAutoArrangePositions(nodes, connections);
        expect(positions.get('p1')).toEqual({ x: 100, y: 110 });
        expect(positions.get('p2')).toEqual({ x: 100, y: 290 });
        expect(positions.get('m')).toEqual({ x: 800, y: 190 });
    });
});

describe('disconnected components', () => {
    it('stacks components with COMPONENT_VERTICAL_GAP, trigger-containing first', () => {
        // The bigger non-trigger component is listed first in the input, but the
        // start-containing component must be laid out on top.
        const nodes = [
            node('x1', 'python'),
            node('x2', 'python'),
            node('x3', 'python'),
            node('start', 'start'),
            node('s2', 'python'),
        ];
        const connections = [conn('x1', 'x2'), conn('x2', 'x3'), conn('start', 's2')];

        const positions = computeAutoArrangePositions(nodes, connections);
        // Trigger component at the top: bottomY = 110 + 60 = 170.
        expect(positions.get('start')).toEqual({ x: 100, y: 110 });
        expect(positions.get('s2')).toEqual({ x: 800, y: 110 });
        // Second component starts at 170 + 500 = 670: cy 700 → port 700 → y 670.
        expect(positions.get('x1')).toEqual({ x: 100, y: 670 });
        expect(positions.get('x2')).toEqual({ x: 800, y: 670 });
        expect(positions.get('x3')).toEqual({ x: 1480, y: 670 });
    });

    it('orders equal-priority components by size descending', () => {
        const nodes = [
            node('b1', 'python'),
            node('b2', 'python'),
            node('a1', 'python'),
            node('a2', 'python'),
            node('a3', 'python'),
        ];
        const connections = [conn('b1', 'b2'), conn('a1', 'a2'), conn('a2', 'a3')];

        const positions = computeAutoArrangePositions(nodes, connections);
        // 3-node component first even though the 2-node component appears first in input.
        expect(positions.get('a1')!.y).toBeLessThan(positions.get('b1')!.y);
        expect(positions.get('a1')).toEqual({ x: 100, y: 110 });
        expect(positions.get('b1')).toEqual({ x: 100, y: 670 });
    });
});

describe('isolated nodes and note exclusion', () => {
    it('places isolated nodes in a bottom row and drops note nodes entirely', () => {
        const nodes = [
            node('start', 'start'),
            node('a', 'python'),
            node('i1', 'python'),
            node('i2', 'python'),
            node('n1', 'note'),
        ];
        const connections = [conn('start', 'a')];

        const positions = computeAutoArrangePositions(nodes, connections);
        // Connected component bottom = 170; isolated row at 170 + COMPONENT_VERTICAL_GAP = 670.
        expect(positions.get('i1')).toEqual({ x: 100, y: 670 });
        // Next isolated x = 100 + 330 + 360 = 790 → snapped 800.
        expect(positions.get('i2')).toEqual({ x: 800, y: 670 });
        expect(positions.has('n1')).toBe(false);
        expect(positions.size).toBe(4);
    });

    it('starts the isolated row at CANVAS_START_Y when there is no connected component', () => {
        const positions = computeAutoArrangePositions([node('i1', 'python')], []);
        expect(positions.get('i1')).toEqual({ x: 100, y: 100 });
    });
});

describe('grid snapping', () => {
    it('snapToGrid rounds to the nearest 20px cell', () => {
        expect(snapToGrid(0)).toBe(0);
        expect(snapToGrid(9)).toBe(0);
        expect(snapToGrid(10)).toBe(20); // Math.round half-up
        expect(snapToGrid(125)).toBe(120);
        expect(snapToGrid(130)).toBe(140);
        expect(snapToGrid(790)).toBe(800);
    });

    it('snaps port Y (center) to the grid, not the top-left corner', () => {
        // Height 50: root cy = 100 + 25 = 125 → snapped port 120 → y = 120 - round(25) = 95.
        const size = { width: 330, height: 50 };
        const nodes = [node('r', 'python', size), node('s', 'python', size)];
        const positions = computeAutoArrangePositions(nodes, [conn('r', 's')]);

        expect(positions.get('r')).toEqual({ x: 100, y: 95 });
        expect(positions.get('s')).toEqual({ x: 800, y: 95 });

        for (const [id, pos] of positions) {
            const height = nodes.find((n) => n.id === id)!.size!.height;
            expect(pos.x % GRID_CELL_SIZE).toBe(0);
            // Top-left y itself is NOT grid-aligned; the port center is.
            expect((pos.y + Math.round(height / 2)) % GRID_CELL_SIZE).toBe(0);
        }
    });
});

describe('cycle safety', () => {
    it('does not hang on a pure cycle and keeps every node in layer 0', () => {
        // No trigger, no zero-in-degree node → all nodes become roots (layer 0),
        // stacked vertically in the single left column.
        const nodes = [node('a', 'python'), node('b', 'python'), node('c', 'python')];
        const connections = [conn('a', 'b'), conn('b', 'c'), conn('c', 'a')];

        const positions = computeAutoArrangePositions(nodes, connections);
        expect(positions.size).toBe(3);
        expect(positions.get('a')).toEqual({ x: 100, y: 110 });
        expect(positions.get('b')).toEqual({ x: 100, y: 290 });
        expect(positions.get('c')).toEqual({ x: 100, y: 470 });
    });

    it('keeps first-seen layers when a back-edge closes a loop', () => {
        // start→a→b plus back-edge b→a: a stays in layer 1, b in layer 2.
        const nodes = [node('start', 'start'), node('a', 'python'), node('b', 'python')];
        const connections = [conn('start', 'a'), conn('a', 'b'), conn('b', 'a')];

        const positions = computeAutoArrangePositions(nodes, connections);
        expect(positions.get('start')).toEqual({ x: 100, y: 110 });
        expect(positions.get('a')).toEqual({ x: 800, y: 110 });
        expect(positions.get('b')).toEqual({ x: 1480, y: 110 });
    });
});
