'use client';

import { useApiUrl } from '@/lib/runtime-config';
import {
  ArrowPathIcon,
  ChartBarIcon,
  FolderIcon,
  ServerIcon
} from '@heroicons/react/24/outline';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';

interface StorageStatsData {
  storage: {
    totalObjects: number;
    totalSize: number;
    totalSizeFormatted: string;
    estimatedDiskUsage: string;
    averageFileSize: string;
  };
  largestFile: {
    name: string;
    size: string;
  };
  bucket: string;
  timestamp: string;
  mountPath?: string;
  cacheEnabled?: boolean;
  cacheTTL?: string;
  calculationTime?: string;
  cacheAge?: string;
  calculatingInBackground?: boolean;
}

// Expose refresh method via ref
export interface StorageStatsRef {
  refresh: (forceRefresh?: boolean) => void;
}

const StorageStats = forwardRef<StorageStatsRef>(function StorageStats(_, ref) {
  const buildApiUrl = useApiUrl();
  const [stats, setStats] = useState<StorageStatsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      // Add small delay to allow server cache to be invalidated and MinIO to sync
      if (forceRefresh) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      // Add refresh parameter for force refresh, increase timeout to 5 minutes for large storage
      const url = forceRefresh ? buildApiUrl('/stats?refresh=true') : buildApiUrl('/stats');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout

      const response = await fetch(url, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error('Failed to fetch statistics');
      }
      const data = await response.json();
      setStats(data);
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          setError('Request timeout - stats calculation taking too long');
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to load statistics');
      }
    } finally {
      setLoading(false);
    }
  }, [buildApiUrl]);

  // Expose refresh method via ref for parent components
  useImperativeHandle(ref, () => ({
    refresh: (forceRefresh = true) => {
      fetchStats(forceRefresh);
    }
  }), [fetchStats]);

  useEffect(() => {
    // Load stats once on mount, no auto-refresh
    fetchStats();
  }, [fetchStats]);

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-600 text-sm">Error loading statistics: {error}</p>
      </div>
    );
  }

  if (loading && !stats) {
    return (
      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="space-y-3">
            <div className="h-3 bg-gray-200 rounded w-1/2"></div>
            <div className="h-3 bg-gray-200 rounded w-3/4"></div>
            <div className="h-3 bg-gray-200 rounded w-1/3"></div>
          </div>
        </div>
      </div>
    );
  }

  if (!stats) {
    return null;
  }

  const formatNumber = (num: number): string => {
    return num.toLocaleString();
  };

  const calculateUsagePercentage = (used: number, total: number): number => {
    if (total === 0) return 0;
    return Math.min((used / total) * 100, 100);
  };

  // For demo purposes, assuming 100GB total storage
  // In production, you'd get this from MinIO admin API or configuration
  const TOTAL_STORAGE_GB = 100;
  const usedStorageGB = stats.storage.totalSize / (1024 * 1024 * 1024);
  const usagePercentage = calculateUsagePercentage(usedStorageGB, TOTAL_STORAGE_GB);

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold flex items-center">
          <ChartBarIcon className="h-5 w-5 mr-2 text-blue-600" />
          Storage Statistics
        </h3>
        <button
          onClick={() => fetchStats(true)}
          disabled={loading}
          className="p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          title="Refresh statistics (may take several minutes for large storage)"
        >
          <ArrowPathIcon className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        {/* Total Objects */}
        <div className="bg-blue-50 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-blue-600 font-medium">Total Objects</p>
              <p className="text-2xl font-bold text-blue-900">
                {formatNumber(stats.storage.totalObjects)}
              </p>
              <p className="text-xs text-blue-600 mt-1">
                Avg size: {stats.storage.averageFileSize}
              </p>
            </div>
            <FolderIcon className="h-8 w-8 text-blue-400" />
          </div>
        </div>

        {/* Storage Used */}
        <div className="bg-green-50 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-green-600 font-medium">Storage Used</p>
              <p className="text-2xl font-bold text-green-900">
                {stats.storage.totalSizeFormatted}
              </p>
              <p className="text-xs text-green-600 mt-1">
                Disk usage: {stats.storage.estimatedDiskUsage}
              </p>
            </div>
            <ServerIcon className="h-8 w-8 text-green-400" />
          </div>
        </div>

        {/* Largest File */}
        <div className="bg-purple-50 rounded-lg p-4">
          <div className="flex-1">
            <p className="text-xs text-purple-600 font-medium">Largest File</p>
            <p className="text-lg font-bold text-purple-900 truncate" title={stats.largestFile.name}>
              {stats.largestFile.size}
            </p>
            <p className="text-xs text-purple-600 mt-1 truncate" title={stats.largestFile.name}>
              {stats.largestFile.name ? stats.largestFile.name.split('/').pop() : 'N/A'}
            </p>
          </div>
        </div>
      </div>

      {/* Storage Usage Bar */}
      <div className="mt-4">
        <div className="flex justify-between text-sm text-gray-600 mb-2">
          <span>Storage Usage</span>
          <span>
            {usedStorageGB.toFixed(2)} GB / {TOTAL_STORAGE_GB} GB
            ({usagePercentage.toFixed(1)}%)
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              usagePercentage > 80 ? 'bg-red-500' :
              usagePercentage > 60 ? 'bg-yellow-500' :
              'bg-green-500'
            }`}
            style={{ width: `${usagePercentage}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          <span>0 GB</span>
          <span>{TOTAL_STORAGE_GB} GB</span>
        </div>
      </div>

      {/* Last Updated & Cache Info */}
      <div className="mt-4 space-y-1">
        <div className="flex justify-between items-center text-xs text-gray-500">
          <div>
            {loading && (
              <div className="flex items-center text-blue-600">
                <span>Calculating statistics... This may take several minutes for large storage.</span>
              </div>
            )}
          </div>
          <div className="text-right">
            Last updated: {new Date(stats.timestamp).toLocaleString()}
          </div>
        </div>

        <div className="flex justify-between items-center text-xs text-gray-400">
          <div className="flex gap-3">
            {stats.calculationTime && (
              <span>Calculation: {stats.calculationTime}</span>
            )}
            {stats.cacheAge && stats.cacheAge !== '0s' && (
              <span>Cache age: {stats.cacheAge}</span>
            )}
          </div>
          <div>
            {stats.cacheEnabled && (
              <span>Auto-refresh: Every 5 min</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export default StorageStats;