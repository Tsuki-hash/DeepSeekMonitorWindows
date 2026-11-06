// Read-only, Windows/NTFS output check for release-checksum.ps1.
// The caller must retain the original output handle AND LockedFileSnapshot's
// source/ancestor handles until this check and output disposal have completed.
// Attribute access is not blocked by FileShare.None: these are observations,
// not a metadata lock or a guarantee against changes after the observations.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace DeepSeekMonitor.ReleaseVerification
{
    public static class ChecksumOutputBinding
    {
        private const uint FileReadAttributes = 0x80;
        private const uint ShareReadWriteDelete = 7;
        private const uint OpenExisting = 3;
        private const uint OpenReparsePoint = 0x00200000;
        private const uint DiskFileType = 1;
        private const uint DirectoryAttribute = 0x10;
        private const uint DeviceAttribute = 0x40;
        private const uint ReparsePointAttribute = 0x400;

        // BY_HANDLE_FILE_INFORMATION: DWORDs and three 8-byte FILETIMEs, in
        // native declaration order. NTFS uses the 64-bit index plus volume
        // serial for identity; this layout is not a ReFS identity substitute.
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

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern uint GetFileType(SafeFileHandle handle);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle,
            out FileInformation information);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle,
            StringBuilder volumeName, uint volumeCapacity, out uint serial,
            out uint maximumComponentLength, out uint flags,
            StringBuilder fileSystemName, uint fileSystemCapacity);

        private static Win32Exception NativeError(string operation)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }

        private static FileInformation ReadPlainFile(SafeFileHandle handle)
        {
            if (handle == null || handle.IsInvalid || handle.IsClosed)
                throw new IOException("Cannot inspect a missing or closed checksum output handle");
            // UNKNOWN (including query failure), PIPE and CHAR are all rejected.
            if (GetFileType(handle) != DiskFileType)
                throw new IOException("Cannot confirm checksum output is a disk file");
            FileInformation information;
            if (!GetFileInformationByHandle(handle, out information))
                throw NativeError("Cannot confirm checksum output attributes and identity");
            // Reject every reparse tag, not just name-surrogate/symlink tags.
            // FILE_ATTRIBUTE_NORMAL need not be set: ordinary new files may
            // legitimately carry ARCHIVE, COMPRESSED or other attributes.
            if ((information.Attributes & (DirectoryAttribute | DeviceAttribute | ReparsePointAttribute)) != 0)
                throw new IOException("Checksum output is not a plain non-reparse file");
            return information;
        }

        private static void RequireNtfs(SafeFileHandle handle, FileInformation information)
        {
            var fileSystem = new StringBuilder(32);
            uint serial, maximumComponentLength, flags;
            if (!GetVolumeInformationByHandleW(handle, null, 0, out serial,
                out maximumComponentLength, out flags, fileSystem, (uint)fileSystem.Capacity))
                throw NativeError("Cannot confirm the checksum output filesystem");
            if (!String.Equals(fileSystem.ToString(), "NTFS", StringComparison.OrdinalIgnoreCase) ||
                serial != information.VolumeSerial)
                throw new IOException("Checksum output requires a confirmed local NTFS identity");
        }

        private static bool SameFile(FileInformation left, FileInformation right)
        {
            return left.VolumeSerial == right.VolumeSerial &&
                left.IndexHigh == right.IndexHigh && left.IndexLow == right.IndexLow;
        }

        private static void RequireVolumeGuidPath(string path)
        {
            // Accept only the stable namespace supplied by LockedFileSnapshot;
            // no drive letters, UNC, relative traversal or alternate streams.
            const string prefix = @"\\?\Volume{";
            if (String.IsNullOrEmpty(path) || !path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Checksum output requires a canonical local volume GUID path");
            int end = path.IndexOf("}\\", StringComparison.Ordinal);
            Guid volume;
            if (end < prefix.Length || !Guid.TryParseExact(path.Substring(prefix.Length, end - prefix.Length), "D", out volume))
                throw new IOException("Cannot confirm checksum output volume GUID");
            foreach (string part in path.Substring(end + 2).Split('\\'))
                if (part.Length == 0 || part == "." || part == ".." ||
                    part.IndexOf(':') >= 0 || part.IndexOf('/') >= 0 || part.IndexOf('\0') >= 0)
                    throw new IOException("Unsupported checksum output path component");
        }

        public static void Validate(SafeFileHandle original, string canonicalPath)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new PlatformNotSupportedException("Checksum output binding requires Windows and local NTFS");
            RequireVolumeGuidPath(canonicalPath);
            FileInformation written = ReadPlainFile(original);
            RequireNtfs(original, written);

            // No data read/write or delete access: FILE_READ_ATTRIBUTES can
            // coexist with the original ReadWrite + FileShare.None handle.
            // Share all existing accesses, without weakening that original
            // handle's sharing restrictions. This handle supplies no new lock.
            // OPEN_REPARSE_POINT opens the final path component itself. Never
            // reopen normally and accidentally compare a reparse target.
            var bound = CreateFileW(canonicalPath, FileReadAttributes, ShareReadWriteDelete,
                IntPtr.Zero, OpenExisting, OpenReparsePoint, IntPtr.Zero);
            if (bound.IsInvalid)
            {
                var error = NativeError("Cannot inspect the checksum output path without following reparse points");
                bound.Dispose();
                throw error;
            }
            using (bound)
            {
                FileInformation named = ReadPlainFile(bound);
                RequireNtfs(bound, named);
                if (!SameFile(written, named))
                    throw new IOException("Checksum output path no longer names the written file");
                // Re-observe the still-owned original after the path query too.
                // These queries cannot make concurrent metadata writes atomic.
                if (!SameFile(written, ReadPlainFile(original)))
                    throw new IOException("Checksum output identity changed during validation");
            }
        }
    }
}
