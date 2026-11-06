// Windows regression fixture only. Never used by the release verifier itself.
// Callers supply paths inside their newly created, isolated evidence directory.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace DeepSeekMonitor.ReleaseVerification.Tests
{
    public sealed class TestFileIdentity
    {
        public uint VolumeSerialNumber { get; private set; }
        public uint FileIndexHigh { get; private set; }
        public uint FileIndexLow { get; private set; }

        internal TestFileIdentity(uint volume, uint high, uint low)
        {
            VolumeSerialNumber = volume;
            FileIndexHigh = high;
            FileIndexLow = low;
        }

        public bool IsSameFile(TestFileIdentity other)
        {
            return other != null && VolumeSerialNumber == other.VolumeSerialNumber &&
                FileIndexHigh == other.FileIndexHigh && FileIndexLow == other.FileIndexLow;
        }

        public override string ToString()
        {
            return String.Format("{0:X8}:{1:X8}{2:X8}", VolumeSerialNumber, FileIndexHigh, FileIndexLow);
        }
    }

    public static class LiteralHardLink
    {
        private const uint ShareReadWriteDelete = 7;
        private const uint OpenExisting = 3;
        private const uint OpenReparsePoint = 0x00200000;
        private const uint DirectoryAttribute = 0x10;
        private const uint ReparsePointAttribute = 0x400;

        [StructLayout(LayoutKind.Sequential)]
        private struct FileInformation
        {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint SizeHigh;
            public uint SizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateHardLinkW(string newFileName, string existingFileName, IntPtr securityAttributes);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access,
            uint share, IntPtr security, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);

        private static void RequireWindows()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new PlatformNotSupportedException("Hard-link fixtures require Windows and local NTFS");
        }

        public static void Create(string alias, string target)
        {
            RequireWindows();
            // The Unicode API receives the complete paths literally, including [].
            // No PowerShell provider, wildcard escaping, delete/retry or copy fallback.
            if (!CreateHardLinkW(alias, target, IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                throw new Win32Exception(error, "CreateHardLinkW failed (Win32 " + error +
                    "): alias=" + alias + "; target=" + target);
            }
        }

        public static TestFileIdentity ReadIdentity(string path)
        {
            RequireWindows();
            // Metadata only, sharing read/write/delete: this probe must not supply
            // the lock being tested. Every handle is closed before returning.
            var handle = CreateFileW(path, 0, ShareReadWriteDelete, IntPtr.Zero,
                OpenExisting, OpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "CreateFileW identity probe failed (Win32 " + error + "): " + path);
            }
            using (handle)
            {
                FileInformation information;
                if (!GetFileInformationByHandle(handle, out information))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw new Win32Exception(error, "GetFileInformationByHandle failed (Win32 " + error + "): " + path);
                }
                if ((information.Attributes & (DirectoryAttribute | ReparsePointAttribute)) != 0)
                    throw new IOException("Hard-link identity probe requires a plain file: " + path);
                return new TestFileIdentity(information.VolumeSerialNumber, information.FileIndexHigh, information.FileIndexLow);
            }
        }
    }
}
