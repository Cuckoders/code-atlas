import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, {
  type ForceGraphMethods,
  type NodeObject,
} from 'react-force-graph-3d';
import SpriteText from 'three-spritetext';
import * as THREE from 'three';
import type { AtlasEdge, AtlasNode, EdgeKind, NodeKind } from '../../shared/graph';

interface Graph3DProps {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  search: string;
  selectedId?: string;
  onSelect: (node: AtlasNode | null) => void;
}

interface ThreeNodeData {
  id: string;
  atlas: AtlasNode;
  dimmed: boolean;
  color: string;
  x?: number;
  y?: number;
  z?: number;
}

interface ThreeLinkData {
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
}

const COLOR_BY_KIND: Record<NodeKind, string> = {
  project: '#f4cd72',
  service: '#7ee2c5',
  database: '#f08bb4',
  module: '#74b7ff',
  controller: '#bf91ff',
  class: '#ffac75',
  interface: '#8ea4ff',
  function: '#b7c4d9',
};

const RADIUS_BY_KIND: Record<NodeKind, number> = {
  project: 5.4,
  service: 4.4,
  database: 4.1,
  module: 3.2,
  controller: 3.4,
  class: 2.8,
  interface: 2.8,
  function: 2.4,
};

export default function Graph3D({ nodes, edges, search, selectedId, onSelect }: Graph3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<ThreeNodeData, ThreeLinkData>>(undefined);
  const [size, setSize] = useState({ width: 900, height: 650 });
  const normalizedSearch = search.trim().toLowerCase();

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.max(320, Math.floor(entry.contentRect.width)),
        height: Math.max(320, Math.floor(entry.contentRect.height)),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const graphData = useMemo(() => {
    const graphNodes: ThreeNodeData[] = nodes.map((atlas) => ({
      id: atlas.id,
      atlas,
      color: atlas.metadata?.gitChange ? '#e2c767' : COLOR_BY_KIND[atlas.kind],
      dimmed: Boolean(normalizedSearch) && !`${atlas.label} ${atlas.path ?? ''} ${atlas.language ?? ''}`
        .toLowerCase()
        .includes(normalizedSearch),
    }));
    const graphLinks: ThreeLinkData[] = edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      label: edge.label,
    }));
    return { nodes: graphNodes, links: graphLinks };
  }, [edges, nodes, normalizedSearch]);

  const createNodeObject = useCallback((node: NodeObject<ThreeNodeData>) => {
    const atlas = node.atlas;
    const radius = RADIUS_BY_KIND[atlas.kind];
    const group = new THREE.Group();
    const geometry = new THREE.IcosahedronGeometry(radius, atlas.kind === 'project' ? 2 : 1);
    const material = new THREE.MeshStandardMaterial({
      color: node.color,
      emissive: node.color,
      emissiveIntensity: selectedId === atlas.id ? 0.72 : 0.23,
      metalness: 0.3,
      roughness: 0.42,
      opacity: node.dimmed ? 0.12 : 0.94,
      transparent: true,
    });
    group.add(new THREE.Mesh(geometry, material));

    if (selectedId === atlas.id) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius * 1.55, 0.18, 8, 40),
        new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.72 }),
      );
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
    }

    const label = new SpriteText(atlas.label);
    label.color = node.dimmed ? '#46505f' : '#dfe6ef';
    label.textHeight = atlas.kind === 'project' || atlas.kind === 'service' ? 3.4 : 2.7;
    label.fontFace = 'DM Mono, monospace';
    label.fontWeight = '500';
    label.backgroundColor = node.dimmed ? '#090b1020' : '#090b10d9';
    label.padding = [3, 1.8];
    label.borderRadius = 3;
    label.position.y = radius + 3.1;
    group.add(label);
    return group;
  }, [selectedId]);

  const focusNode = useCallback((node: NodeObject<ThreeNodeData>) => {
    if (![node.x, node.y, node.z].every((coordinate) => Number.isFinite(coordinate))) return;
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const z = node.z ?? 0;
    const distance = Math.hypot(x, y, z);
    const ratio = distance > 0 ? 1 + 72 / distance : 1;
    graphRef.current?.cameraPosition(
      { x: x * ratio, y: y * ratio, z: z * ratio + (distance > 0 ? 0 : 72) },
      { x, y, z },
      700,
    );
  }, []);

  const handleNodeClick = useCallback((node: NodeObject<ThreeNodeData>) => {
    onSelect(node.atlas);
    focusNode(node);
  }, [focusNode, onSelect]);

  return (
    <div className="graph-3d" ref={containerRef}>
      <ForceGraph3D<ThreeNodeData, ThreeLinkData>
        ref={graphRef}
        width={size.width}
        height={size.height}
        graphData={graphData}
        backgroundColor="#090b10"
        showNavInfo={false}
        nodeLabel={(node) => `${node.atlas.kind} · ${node.atlas.label}`}
        nodeThreeObject={createNodeObject}
        nodeThreeObjectExtend={false}
        linkColor={(link) => link.kind === 'uses' ? '#a35d82' : link.kind === 'calls' ? '#d18b55' : link.kind === 'imports' ? '#3f739d' : '#3b4654'}
        linkWidth={(link) => link.kind === 'contains' ? 0.55 : 1.1}
        linkOpacity={0.42}
        linkDirectionalArrowLength={(link) => link.kind === 'contains' ? 1.6 : 2.7}
        linkDirectionalArrowRelPos={1}
        linkDirectionalParticles={(link) => link.kind === 'imports' || link.kind === 'calls' ? 1 : 0}
        linkDirectionalParticleColor={() => '#78b9e9'}
        linkDirectionalParticleSpeed={0.004}
        linkDirectionalParticleWidth={1.4}
        warmupTicks={70}
        cooldownTicks={240}
        d3VelocityDecay={0.32}
        onEngineStop={() => graphRef.current?.zoomToFit(650, 35)}
        onNodeClick={handleNodeClick}
        onBackgroundClick={() => onSelect(null)}
      />
      <div className="graph-3d__hud">
        <span><i /> drag — вращение</span>
        <span><i /> scroll — масштаб</span>
        <span><i /> drag node — перемещение</span>
      </div>
      <button
        type="button"
        className="graph-3d__reset"
        onClick={() => graphRef.current?.zoomToFit(700, 35)}
      >
        Свести карту
      </button>
    </div>
  );
}
