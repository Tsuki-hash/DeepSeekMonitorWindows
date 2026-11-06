// Test-only helpers. All paths must be inside a new, user-controlled evidence
// directory. No fixture is an actual installer, and nothing is ever executed.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace DeepSeekMonitor.ReleaseVerification.Tests
{
    // Used only by isolated live-process test copies. It opens exactly as the
    // production FileStream does, but can fail the actual Flush(true) call while
    // leaving the handle open. Disposing first would conceal a missing finally.
    public sealed class ChecksumProbeStream : FileStream
    {
        private readonly bool failDurableFlush;
        public int DisposeCalls { get; private set; }
        public int DurableFlushFaults { get; private set; }

        public ChecksumProbeStream(string path, FileMode mode, FileAccess access,
            FileShare share, bool failDurableFlush) : base(path, mode, access, share)
        {
            this.failDurableFlush = failDurableFlush;
        }

        public override void Flush(bool flushToDisk)
        {
            if (failDurableFlush && flushToDisk)
            {
                DurableFlushFaults++;
                throw new IOException("injected durable Flush failure with the output handle still open");
            }
            base.Flush(flushToDisk);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) DisposeCalls++;
            base.Dispose(disposing);
        }
    }

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

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,
            System.Text.StringBuilder path, uint capacity, uint flags);

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

        public static string ReadCanonicalPath(SafeFileHandle handle)
        {
            var path = new System.Text.StringBuilder(512);
            uint length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 1);
            if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resolve fixture volume GUID path");
            if (length >= path.Capacity)
            {
                path = new System.Text.StringBuilder(checked((int)length + 1));
                length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 1);
                if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resolve fixture volume GUID path");
                if (length >= path.Capacity) throw new IOException("Fixture path changed during query");
            }
            return path.ToString();
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

        public static void SetEmptyFileSymbolicLinkReparsePoint(string path, string target)
        {
            // Only new test files. Convert the existing object with attribute
            // access while its producer still owns FileShare.None; do not unlink
            // it or substitute a newly created CreateSymbolicLinkW object.
            if (String.IsNullOrEmpty(target) || !target.StartsWith(@"\\?\", StringComparison.Ordinal) ||
                target.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) || target.IndexOf('\0') >= 0)
                throw new ArgumentException("A local extended target path is required", "target");
            string substitute = @"\??\" + target.Substring(4);
            var encoding = new System.Text.UnicodeEncoding(false, false, true);
            byte[] substituteBytes = encoding.GetBytes(substitute);
            byte[] printBytes = encoding.GetBytes(target);
            int pathBytes = checked(substituteBytes.Length + 2 + printBytes.Length + 2);
            int dataLength = checked(12 + pathBytes);
            int total = checked(8 + dataLength);
            if (total > 16 * 1024) throw new IOException("Reparse fixture target exceeds the native buffer limit");
            byte[] buffer = new byte[total];
            // 8-byte REPARSE_DATA_BUFFER header, 12-byte symbolic-link header,
            // UTF-16LE substitute and print paths. Offsets are in PathBuffer
            // bytes; both paths are NUL terminated and absolute (Flags = 0).
            Array.Copy(BitConverter.GetBytes(0xA000000Cu), 0, buffer, 0, 4);
            Array.Copy(BitConverter.GetBytes(checked((ushort)dataLength)), 0, buffer, 4, 2);
            Array.Copy(BitConverter.GetBytes(checked((ushort)substituteBytes.Length)), 0, buffer, 10, 2);
            Array.Copy(BitConverter.GetBytes(checked((ushort)(substituteBytes.Length + 2))), 0, buffer, 12, 2);
            Array.Copy(BitConverter.GetBytes(checked((ushort)printBytes.Length)), 0, buffer, 14, 2);
            Array.Copy(substituteBytes, 0, buffer, 20, substituteBytes.Length);
            Array.Copy(printBytes, 0, buffer, 20 + substituteBytes.Length + 2, printBytes.Length);

            // FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES, share read/write/delete,
            // OPEN_EXISTING | OPEN_REPARSE_POINT. No data write or delete access.
            var handle = CreateFileW(path, 0x80 | 0x100, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "NOT RUN: cannot open empty reparse fixture with attribute access: " + path);
            }
            using (handle)
            {
                FileInformation before;
                if (!GetFileInformationByHandle(handle, out before))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect empty reparse fixture");
                if ((before.Attributes & (0x10 | 0x400)) != 0 || before.SizeHigh != 0 || before.SizeLow != 0)
                    throw new IOException("Reparse fixture must still be an empty ordinary file");
                IntPtr native = Marshal.AllocHGlobal(buffer.Length);
                try
                {
                    Marshal.Copy(buffer, 0, native, buffer.Length);
                    uint returned;
                    if (!DeviceIoControl(handle, 0x000900A4, native, (uint)buffer.Length,
                        null, 0, out returned, IntPtr.Zero))
                        throw new Win32Exception(Marshal.GetLastWin32Error(),
                            "NOT RUN: FSCTL_SET_REPARSE_POINT capability/attack failed; never count this as PASS");
                }
                finally { Marshal.FreeHGlobal(native); }
                FileInformation after;
                if (!GetFileInformationByHandle(handle, out after))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot confirm converted reparse fixture");
                if ((after.Attributes & 0x400) == 0 || (after.Attributes & 0x10) != 0 ||
                    before.VolumeSerial != after.VolumeSerial || before.IndexHigh != after.IndexHigh || before.IndexLow != after.IndexLow)
                    throw new IOException("FSCTL_SET_REPARSE_POINT did not preserve and convert the same file object");
            }
        }
    }
}
