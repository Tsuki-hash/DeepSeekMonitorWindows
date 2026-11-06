// Windows-only, read-only identity/namespace guard for verify-release.ps1.
// Never load or execute the candidate PE. No file is created or modified here.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace DeepSeekMonitor.ReleaseVerification
{
    public sealed class LockedFileSnapshot : IDisposable
    {
        private const uint GenericRead = 0x80000000;
        private const uint ShareRead = 1;
        private const uint OpenExisting = 3;
        private const uint BackupSemantics = 0x02000000;
        private const uint OpenReparsePoint = 0x00200000;
        private const uint DirectoryAttribute = 0x10;
        private const uint ReparsePointAttribute = 0x400;
        private const uint VolumeNameGuid = 1;

        [StructLayout(LayoutKind.Sequential)]
        private struct FileInformation
        {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerial;
            public uint SizeHigh;
            public uint SizeLow;
            public uint NumberOfLinks;
            public uint IndexHigh;
            public uint IndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access,
            uint share, IntPtr security, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle,
            out FileInformation information);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,
            StringBuilder path, uint capacity, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle,
            StringBuilder volumeName, uint volumeCapacity, out uint serial,
            out uint maximumComponentLength, out uint flags,
            StringBuilder fileSystemName, uint fileSystemCapacity);

        private FileStream source;
        private readonly List<SafeFileHandle> directories = new List<SafeFileHandle>();
        private FileInformation identity;
        public string LockedPath { get; private set; }
        public byte[] Bytes { get; private set; }
        public string Identity
        {
            get { return String.Format("{0:X8}:{1:X8}{2:X8}", identity.VolumeSerial, identity.IndexHigh, identity.IndexLow); }
        }

        private static Win32Exception NativeError(string operation)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }

        private static FileInformation Information(SafeFileHandle handle)
        {
            FileInformation value;
            if (!GetFileInformationByHandle(handle, out value))
                throw NativeError("Cannot confirm file identity");
            return value;
        }

        private static string FinalPath(SafeFileHandle handle)
        {
            var buffer = new StringBuilder(512);
            uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, VolumeNameGuid);
            if (length == 0) throw NativeError("Cannot resolve a local volume GUID path");
            if (length >= buffer.Capacity)
            {
                buffer = new StringBuilder(checked((int)length + 1));
                length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, VolumeNameGuid);
                if (length == 0) throw NativeError("Cannot resolve a local volume GUID path");
                if (length >= buffer.Capacity) throw new IOException("File namespace changed while resolving its path");
            }
            return buffer.ToString();
        }

        private void LockDirectory(string path)
        {
            // GENERIC_READ participates in Windows sharing checks; a metadata-only
            // FILE_READ_ATTRIBUTES handle is NOT a namespace/rename guard.
            // These directory handles do not lock child files.
            var handle = CreateFileW(path, GenericRead, ShareRead, IntPtr.Zero,
                OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                var error = NativeError("Cannot lock a parent directory: " + path);
                handle.Dispose();
                throw error;
            }
            directories.Add(handle);
            var info = Information(handle);
            if ((info.Attributes & DirectoryAttribute) == 0 || (info.Attributes & ReparsePointAttribute) != 0)
                throw new IOException("A parent is not a plain directory: " + path);
            if (!String.Equals(FinalPath(handle).TrimEnd('\\'), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                throw new IOException("A parent path cannot be bound to its locked directory: " + path);
        }

        private void ConfirmBinding()
        {
            if (source == null) throw new ObjectDisposedException("LockedFileSnapshot");
            using (var bound = new FileStream(LockedPath, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                var info = Information(bound.SafeFileHandle);
                if (info.VolumeSerial != identity.VolumeSerial || info.IndexHigh != identity.IndexHigh || info.IndexLow != identity.IndexLow)
                    throw new IOException("Confirmed path no longer names the locked file");
            }
        }

        public static LockedFileSnapshot Open(string path)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new PlatformNotSupportedException("Installer identity verification requires Windows and a local NTFS volume");
            var snapshot = new LockedFileSnapshot();
            try
            {
                // Windows sharing is file-object based, including other hard links.
                // An already-open writer/deleter conflicts even if it shares reads.
                snapshot.source = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                snapshot.identity = Information(snapshot.source.SafeFileHandle);
                var fs = new StringBuilder(32);
                uint serial, maximumComponentLength, flags;
                if (!GetVolumeInformationByHandleW(snapshot.source.SafeFileHandle, null, 0,
                    out serial, out maximumComponentLength, out flags, fs, (uint)fs.Capacity))
                    throw NativeError("Cannot confirm the filesystem");
                if (!String.Equals(fs.ToString(), "NTFS", StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Only a confirmed local NTFS file is supported");

                // A volume GUID avoids drive-letter/SUBST rebinding. Lock every
                // ancestor from root to leaf before trusting this pathname again.
                // A file handle alone does NOT protect renaming an ancestor.
                snapshot.LockedPath = FinalPath(snapshot.source.SafeFileHandle);
                const string prefix = @"\\?\Volume{";
                int end = snapshot.LockedPath.IndexOf("}\\", StringComparison.Ordinal);
                Guid volume;
                if (!snapshot.LockedPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || end < prefix.Length ||
                    !Guid.TryParse(snapshot.LockedPath.Substring(prefix.Length, end - prefix.Length), out volume))
                    throw new IOException("Cannot establish a stable local volume path");
                string root = snapshot.LockedPath.Substring(0, end + 2);
                string[] parts = snapshot.LockedPath.Substring(end + 2).Split('\\');
                if (parts.Length == 0) throw new IOException("Missing file name");
                foreach (string part in parts)
                    if (part.Length == 0 || part == "." || part == ".." || part.IndexOf(':') >= 0)
                        throw new IOException("Unsupported path component or alternate data stream");
                snapshot.LockDirectory(root);
                string directory = root.TrimEnd('\\');
                for (int index = 0; index < parts.Length - 1; index++)
                {
                    directory += "\\" + parts[index];
                    snapshot.LockDirectory(directory);
                }
                snapshot.ConfirmBinding();

                long length = snapshot.source.Length;
                if (length > Int32.MaxValue) throw new IOException("Installer is too large for a single byte snapshot");
                snapshot.Bytes = new byte[(int)length];
                int offset = 0;
                while (offset < snapshot.Bytes.Length)
                {
                    int read = snapshot.source.Read(snapshot.Bytes, offset, snapshot.Bytes.Length - offset);
                    if (read == 0) throw new EndOfStreamException("Incomplete installer snapshot");
                    offset += read;
                }
                if (snapshot.source.ReadByte() != -1 || snapshot.source.Length != length)
                    throw new IOException("Installer length changed while reading");
                snapshot.ConfirmBinding();
                return snapshot;
            }
            catch
            {
                snapshot.Dispose();
                throw;
            }
        }

        public void Dispose()
        {
            // Release leaf before parents; all validation has already finished.
            if (source != null) { source.Dispose(); source = null; }
            for (int index = directories.Count - 1; index >= 0; index--) directories[index].Dispose();
            directories.Clear();
        }
    }
}
