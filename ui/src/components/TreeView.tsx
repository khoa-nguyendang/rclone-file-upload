'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  ChevronRightIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderOpenIcon,
  DocumentIcon,
  ArrowDownTrayIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { useRuntimeConfig, useApiUrl } from '@/lib/runtime-config';

interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string;
  children?: TreeNode[];
  loaded?: boolean;
  expanded?: boolean;
}

interface TreeViewProps {
  onFileSelect?: (file: TreeNode) => void;
  onRefresh?: () => void;
}

export default function TreeView({ onFileSelect, onRefresh }: TreeViewProps) {
  const config = useRuntimeConfig();
  const buildApiUrl = useApiUrl();
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState<{ [key: string]: boolean }>({});
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const loadDirectory = useCallback(async (path: string) => {
    console.log('TreeView: Loading directory:', path);
    setLoading(prev => ({ ...prev, [path]: true }));

    try {
      const url = buildApiUrl(`/list?path=${encodeURIComponent(path)}`);
      console.log('TreeView: Fetching from:', url);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to load directory');
      }

      const data = await response.json();
      console.log('TreeView: Received data:', data);
      const nodes: TreeNode[] = (data || []).map((item: any) => ({
        ...item,
        children: item.is_dir ? [] : undefined,
        loaded: false,
        expanded: false,
      }));
      console.log('TreeView: Processed nodes:', nodes);

      if (path === '/') {
        setTreeData(nodes);
      } else {
        // Update the tree with loaded children
        setTreeData(prev => updateTreeChildren(prev, path, nodes));
      }
    } catch (error) {
      console.error('Error loading directory:', error);
    } finally {
      setLoading(prev => ({ ...prev, [path]: false }));
    }
  }, [buildApiUrl]);

  // Load root directory on mount
  useEffect(() => {
    loadDirectory('/');
  }, [loadDirectory]);

  const updateTreeChildren = (
    nodes: TreeNode[],
    targetPath: string,
    children: TreeNode[]
  ): TreeNode[] => {
    return nodes.map(node => {
      if (node.path === targetPath) {
        return {
          ...node,
          children,
          loaded: true,
          expanded: true,
        };
      } else if (node.children) {
        return {
          ...node,
          children: updateTreeChildren(node.children, targetPath, children),
        };
      }
      return node;
    });
  };

  const toggleExpand = useCallback(async (node: TreeNode) => {
    if (!node.is_dir) return;

    const path = node.path;

    if (!node.loaded) {
      // Load children if not loaded yet
      await loadDirectory(path);
    } else {
      // Just toggle expansion
      setTreeData(prev => toggleNodeExpansion(prev, path));
    }
  }, [loadDirectory]);

  const toggleNodeExpansion = (nodes: TreeNode[], targetPath: string): TreeNode[] => {
    return nodes.map(node => {
      if (node.path === targetPath) {
        return { ...node, expanded: !node.expanded };
      } else if (node.children) {
        return {
          ...node,
          children: toggleNodeExpansion(node.children, targetPath),
        };
      }
      return node;
    });
  };

  const handleDownload = (node: TreeNode) => {
    if (!node.is_dir) {
      // Remove leading slash for the download URL
      const cleanPath = node.path.startsWith('/') ? node.path.substring(1) : node.path;
      window.location.href = buildApiUrl(`/download/${encodeURIComponent(cleanPath)}`);
    }
  };

  const handleDelete = async (node: TreeNode) => {
    if (!config.app.enableDelete) return;

    if (!confirm(`Are you sure you want to delete ${node.name}?`)) {
      return;
    }

    try {
      // Remove leading slash for the delete URL
      const cleanPath = node.path.startsWith('/') ? node.path.substring(1) : node.path;
      const response = await fetch(buildApiUrl(`/delete/${encodeURIComponent(cleanPath)}`), {
        method: 'DELETE',
      });

      if (response.ok) {
        // Refresh the parent directory
        const parentPath = node.path.substring(0, node.path.lastIndexOf('/')) || '/';
        await loadDirectory(parentPath);
      } else {
        const errorText = await response.text();
        console.error('Delete failed:', errorText);
        alert(`Failed to delete file: ${errorText}`);
      }
    } catch (error) {
      console.error('Error deleting file:', error);
      alert('Error deleting file');
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString: string): string => {
    try {
      const date = new Date(dateString);
      // Check if date is valid
      if (isNaN(date.getTime())) {
        return '';
      }
      // Format as locale string with shorter format
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return '';
    }
  };

  const renderNode = (node: TreeNode, level: number = 0) => {
    const isLoading = loading[node.path];
    const isSelected = selectedNode === node.path;

    return (
      <div key={node.path}>
        <div
          className={`
            flex items-center py-1.5 px-2 hover:bg-gray-100 cursor-pointer rounded
            ${isSelected ? 'bg-blue-50 border-l-2 border-blue-500' : ''}
          `}
          style={{ paddingLeft: `${level * 20 + 8}px` }}
          onClick={() => {
            setSelectedNode(node.path);
            if (node.is_dir) {
              toggleExpand(node);
            } else if (onFileSelect) {
              onFileSelect(node);
            }
          }}
        >
          {/* Expand/Collapse Icon */}
          {node.is_dir && (
            <span className="mr-1">
              {isLoading ? (
                <div className="animate-spin h-4 w-4 border-2 border-gray-300 border-t-blue-600 rounded-full" />
              ) : node.expanded ? (
                <ChevronDownIcon className="h-4 w-4 text-gray-600" />
              ) : (
                <ChevronRightIcon className="h-4 w-4 text-gray-600" />
              )}
            </span>
          )}

          {/* File/Folder Icon */}
          <span className="mr-2">
            {node.is_dir ? (
              node.expanded ? (
                <FolderOpenIcon className="h-5 w-5 text-blue-600" />
              ) : (
                <FolderIcon className="h-5 w-5 text-blue-600" />
              )
            ) : (
              <DocumentIcon className="h-5 w-5 text-gray-400" />
            )}
          </span>

          {/* Name */}
          <span className="flex-1 text-sm truncate" title={node.name}>
            {node.name}
          </span>

          {/* Last Modified Date */}
          {node.modified && (
            <span className="text-xs text-gray-400 mr-3">
              {formatDate(node.modified)}
            </span>
          )}

          {/* File Size */}
          {!node.is_dir && (
            <span className="text-xs text-gray-500 mr-4">
              {formatFileSize(node.size)}
            </span>
          )}

          {/* Actions */}
          <div className="flex space-x-1 opacity-0 hover:opacity-100 transition-opacity">
            {!node.is_dir && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload(node);
                }}
                className="p-1 hover:bg-blue-100 rounded"
                title="Download"
              >
                <ArrowDownTrayIcon className="h-4 w-4 text-blue-600" />
              </button>
            )}
            {config.app.enableDelete && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(node);
                }}
                className="p-1 hover:bg-red-100 rounded"
                title="Delete"
              >
                <TrashIcon className="h-4 w-4 text-red-600" />
              </button>
            )}
          </div>
        </div>

        {/* Render children if expanded */}
        {node.is_dir && node.expanded && node.children && (
          <div>
            {node.children.map(child => renderNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-4">
      <div className="mb-4 flex justify-between items-center">
        <h3 className="text-lg font-semibold">File Explorer</h3>
        <button
          onClick={() => {
            loadDirectory('/');
            if (onRefresh) onRefresh();
          }}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          Refresh
        </button>
      </div>

      <div className="overflow-auto max-h-[600px]">
        {treeData.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            No files or folders found
          </div>
        ) : (
          treeData.map(node => renderNode(node))
        )}
      </div>
    </div>
  );
}