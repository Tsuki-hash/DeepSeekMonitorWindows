// Test-only helpers. All paths must be inside a new, user-controlled evidence
// directory. No fixture is an actual installer, and nothing is ever executed.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace DeepSeekMonitor.ReleaseVerification.Tests
{
    public static class LiteralChecksumFixtures
    {
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
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateDirectoryW(string path, IntPtr security);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool CreateSymbolicLinkW(string alias, string target, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access,
            uint share, IntPtr security, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeviceIoControl(SafeFileHandle handle, uint code,
            IntPtr input, uint inputLength, [Out] byte[] output, uint outputLength,
            out uint returned, IntPtr overlapped);

        public static void CreateFreshDirectory(string path)
        {
            if (!CreateDirectoryW(path, IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                throw new Win32Exception(error, "Cannot create a fresh evidence directory: " + path);
            }
        }

        public static void CreateFileSymbolicLink(string alias, string target)
        {
            // ALLOW_UNPRIVILEGED_CREATE requires Windows Developer Mode. If it
            // is unavailable, preserve the actual error and fail the suite.
            // Never silently replace a symbolic link fixture with a plain file.
            if (!CreateSymbolicLinkW(alias, target, 2))
            {
                int error = Marshal.GetLastWin32Error();
                throw new Win32Exception(error, "CreateSymbolicLinkW failed: alias=" + alias + "; target=" + target);
            }
        }

        public static string ReadSymbolicLinkEvidence(string path)
        {
            // Metadata-only, share read/write/delete, OPEN_REPARSE_POINT. This
            // examines the link object, never its target, and supplies no lock.
            var handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Cannot inspect symbolic link: " + path);
            }
            using (handle)
            {
                FileInformation info;
                if (!GetFileInformationByHandle(handle, out info))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read symbolic link identity: " + path);
                if ((info.Attributes & 0x400) == 0 || (info.Attributes & 0x10) != 0)
                    throw new IOException("Fixture is not a file reparse point: " + path);
                var data = new byte[16 * 1024];
                uint returned;
                if (!DeviceIoControl(handle, 0x000900A8, IntPtr.Zero, 0,
                    data, (uint)data.Length, out returned, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read raw reparse data: " + path);
                if (returned < 8 || returned > data.Length || BitConverter.ToUInt32(data, 0) != 0xA000000C)
                    throw new IOException("Fixture is not a symbolic link: " + path);
                // Identity plus the complete original reparse data catches both
                // unlink/recreate and retargeting the existing reparse object.
                return String.Format("{0:X8}:{1:X8}{2:X8}:", info.VolumeSerial, info.IndexHigh, info.IndexLow) +
                    Convert.ToBase64String(data, 0, checked((int)returned));
            }
        }
    }
}
