// Parse RT_VERSION only from the already-hashed bytes. FileVersionInfo can merge
// strings from an unlocked .mui sidecar, even when the executable itself is locked.
// Unsupported/ambiguous resource layouts throw; they must never yield static PASS.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace DeepSeekMonitor.ReleaseVerification
{
    public sealed class ReleaseVersionInfo
    {
        public string Resource { get; set; }
        public string FileVersion { get; set; }
        public string ProductVersion { get; set; }
        public int FileMajorPart { get; set; }
        public int FileMinorPart { get; set; }
        public int FileBuildPart { get; set; }
        public int FilePrivatePart { get; set; }
        public bool IsPreRelease { get; set; }
        // Offset in the input snapshot, not a signature scan or a second file read.
        public int FixedFileInfoOffset { get; internal set; }
    }

    public sealed class PeVersionSnapshot
    {
        private readonly byte[] bytes;
        private readonly int sectionTable;
        private readonly int sectionCount;
        private readonly int resourceStart;
        private readonly int resourceLength;
        private readonly List<ReleaseVersionInfo> versions = new List<ReleaseVersionInfo>();
        private readonly Dictionary<uint, VersionLayout> layouts = new Dictionary<uint, VersionLayout>();
        private static readonly Encoding Utf16 = new UnicodeEncoding(false, false, true);

        private static void Bounds(byte[] data, long offset, long length)
        {
            if (offset < 0 || length < 0 || offset > data.LongLength - length)
                throw new InvalidDataException("PE version resource is truncated or out of bounds");
        }
        private static ushort U16(byte[] data, int offset) { Bounds(data, offset, 2); return BitConverter.ToUInt16(data, offset); }
        private static uint U32(byte[] data, int offset) { Bounds(data, offset, 4); return BitConverter.ToUInt32(data, offset); }
        private static int Align4(int offset) { return checked((offset + 3) & ~3); }

        private PeVersionSnapshot(byte[] data)
        {
            bytes = data;
            if (U16(bytes, 0) != 0x5A4D) throw new InvalidDataException("Missing DOS header");
            int pe = checked((int)U32(bytes, 0x3C));
            if (pe < 64 || U32(bytes, pe) != 0x4550) throw new InvalidDataException("Missing PE header");
            sectionCount = U16(bytes, checked(pe + 6));
            int optionalSize = U16(bytes, checked(pe + 20));
            int optional = checked(pe + 24);
            Bounds(bytes, optional, optionalSize);
            int magic = U16(bytes, optional);
            int directoryOffset;
            if (magic == 0x10B) directoryOffset = 96;
            else if (magic == 0x20B) directoryOffset = 112;
            else throw new InvalidDataException("Unsupported PE optional header");
            if (optionalSize < directoryOffset + 24 || U32(bytes, optional + directoryOffset - 4) < 3)
                throw new InvalidDataException("Missing resource data directory");
            uint rva = U32(bytes, optional + directoryOffset + 16);
            uint size = U32(bytes, optional + directoryOffset + 20);
            if (rva == 0 || size < 16) throw new InvalidDataException("Missing PE resources");
            sectionTable = checked(optional + optionalSize);
            Bounds(bytes, sectionTable, 40L * sectionCount);
            ValidateSections();
            resourceLength = checked((int)size);
            resourceStart = MapRva(rva, size);
        }

        private void ValidateSections()
        {
            var ranges = new List<KeyValuePair<ulong, ulong>>();
            for (int index = 0; index < sectionCount; index++)
            {
                int section = checked(sectionTable + index * 40);
                uint virtualSize = U32(bytes, section + 8);
                uint start = U32(bytes, section + 12);
                uint rawSize = U32(bytes, section + 16);
                uint rawOffset = U32(bytes, section + 20);
                Bounds(bytes, rawOffset, rawSize);
                ulong length = Math.Max(virtualSize, rawSize);
                if (length != 0) ranges.Add(new KeyValuePair<ulong, ulong>(start, start + length));
            }
            ranges.Sort((left, right) => left.Key.CompareTo(right.Key));
            ulong previousEnd = 0;
            foreach (var range in ranges)
            {
                if (range.Key < previousEnd || range.Value > (ulong)UInt32.MaxValue + 1)
                    throw new InvalidDataException("Overlapping or overflowing PE virtual sections");
                previousEnd = range.Value;
            }
        }

        private int MapRva(uint rva, uint length)
        {
            int result = -1;
            for (int index = 0; index < sectionCount; index++)
            {
                int section = checked(sectionTable + index * 40);
                uint start = U32(bytes, section + 12);
                uint rawSize = U32(bytes, section + 16);
                uint rawOffset = U32(bytes, section + 20);
                if (rva < start || (ulong)rva - start + length > rawSize) continue;
                long offset = (long)rawOffset + rva - start;
                Bounds(bytes, offset, length);
                if (result >= 0) throw new InvalidDataException("Ambiguous overlapping PE sections");
                result = checked((int)offset);
            }
            if (result < 0) throw new InvalidDataException("Resource RVA is not backed by one complete file section");
            return result;
        }

        private int ResourceOffset(uint offset, int length)
        {
            if (offset > resourceLength || length < 0 || (long)offset + length > resourceLength)
                throw new InvalidDataException("Resource directory entry is out of bounds");
            return checked(resourceStart + (int)offset);
        }

        private List<KeyValuePair<uint, uint>> Directory(uint relative)
        {
            int offset = ResourceOffset(relative, 16);
            int namedCount = U16(bytes, offset + 12);
            int count = namedCount + U16(bytes, offset + 14);
            ResourceOffset(relative, checked(16 + count * 8));
            var entries = new List<KeyValuePair<uint, uint>>();
            uint previousId = 0;
            for (int index = 0; index < count; index++)
            {
                uint key = U32(bytes, offset + 16 + index * 8);
                bool named = (key & 0x80000000) != 0;
                if (named != (index < namedCount))
                    throw new InvalidDataException("Resource named/numeric partitions do not match their entries");
                if (!named)
                {
                    if (key > UInt16.MaxValue || (index > namedCount && key <= previousId))
                        throw new InvalidDataException("Resource numeric IDs are unsupported, unsorted or duplicated");
                    previousId = key;
                }
                entries.Add(new KeyValuePair<uint, uint>(key, U32(bytes, offset + 20 + index * 8)));
            }
            return entries;
        }

        public static ReleaseVersionInfo[] Read(byte[] data)
        {
            if (data == null) throw new InvalidDataException("Missing installer snapshot");
            var reader = new PeVersionSnapshot(data);
            int typeCount = 0;
            int resourceCount = 0;
            foreach (var type in reader.Directory(0))
            {
                if (type.Key != 16) continue; // numeric RT_VERSION only
                typeCount++;
                if (typeCount != 1 || (type.Value & 0x80000000) == 0)
                    throw new InvalidDataException("Ambiguous or invalid RT_VERSION directory");
                var names = reader.Directory(type.Value & 0x7FFFFFFF);
                // VERSIONINFO's versionID must be the numeric ID 1. Searching
                // arbitrary resource names would accept data Windows does not use.
                if (names.Count != 1 || names[0].Key != 1)
                    throw new InvalidDataException("RT_VERSION must contain exactly one numeric version name ID 1");
                foreach (var name in names)
                {
                    if ((name.Value & 0x80000000) == 0)
                        throw new InvalidDataException("Invalid version name directory");
                    foreach (var language in reader.Directory(name.Value & 0x7FFFFFFF))
                    {
                        if ((language.Key & 0xFFFF0000) != 0 || (language.Value & 0x80000000) != 0 || ++resourceCount > 256)
                            throw new InvalidDataException("Unsupported version language directory");
                        int entry = reader.ResourceOffset(language.Value, 16);
                        uint rva = U32(data, entry);
                        uint size = U32(data, entry + 4);
                        if (size < 6 || size > UInt16.MaxValue || (rva & 3) != 0)
                            throw new InvalidDataException("Unsupported version resource size or alignment");
                        int offset = reader.MapRva(rva, size);
                        var blob = new byte[(int)size];
                        Buffer.BlockCopy(data, offset, blob, 0, blob.Length);
                        reader.ReadVersion(blob, String.Format("{0:X8}/{1:X4}", name.Key, language.Key), language.Key, offset);
                    }
                }
            }
            if (typeCount == 0 || reader.versions.Count == 0)
                throw new InvalidDataException("PE version resource is unavailable");
            reader.ValidateTranslations();
            return reader.versions.ToArray();
        }

        private sealed class VersionLayout
        {
            public HashSet<string> Tables;
            public HashSet<string> Translations;
            public bool NsisSelectedTable;
        }

        private void ValidateTranslations()
        {
            foreach (var layout in layouts.Values)
            {
                if (!layout.Tables.IsSubsetOf(layout.Translations))
                    throw new InvalidDataException("Unreferenced version StringTable");
                if (layout.Translations.SetEquals(layout.Tables)) continue;
                // NSIS 3.11 ExportToStream stores one selected table per language
                // resource, but advertises all languages (selected language first).
                // Do not merely allow extra Translation entries: every entry must
                // resolve to its actual language resource, with the same complete
                // mapping. Read() still returns every table for release-rule checks.
                if (!layout.NsisSelectedTable)
                    throw new InvalidDataException("Unsupported cross-resource Translation mapping");
                foreach (string key in layout.Translations)
                {
                    uint language = Convert.ToUInt32(key.Substring(0, 4), 16);
                    VersionLayout target;
                    if (!layouts.TryGetValue(language, out target) || !target.NsisSelectedTable ||
                        !target.Tables.Contains(key) || !target.Translations.SetEquals(layout.Translations))
                        throw new InvalidDataException("Missing or inconsistent cross-resource Translation target");
                }
            }
        }

        private sealed class Block
        {
            public int End;
            public int ValueStart;
            public int ValueLength;
            public int Type;
            public string Key;
        }

        private static Block ReadBlock(byte[] blob, int offset, int limit)
        {
            Bounds(blob, offset, 6);
            int length = U16(blob, offset);
            if (length < 6 || offset > limit - length) throw new InvalidDataException("Invalid version block length");
            var block = new Block { End = offset + length, ValueLength = U16(blob, offset + 2), Type = U16(blob, offset + 4) };
            int keyStart = offset + 6;
            int keyEnd = keyStart;
            while (keyEnd <= block.End - 2 && U16(blob, keyEnd) != 0) keyEnd += 2;
            if (keyEnd > block.End - 2) throw new InvalidDataException("Unterminated version block key");
            block.Key = Utf16.GetString(blob, keyStart, keyEnd - keyStart);
            block.ValueStart = Align4(keyEnd + 2);
            if (block.ValueStart > Align4(block.End)) throw new InvalidDataException("Invalid version value alignment");
            return block;
        }

        private static IEnumerable<Block> Children(byte[] blob, int start, int end)
        {
            int offset = Align4(start);
            while (offset < end)
            {
                if (end - offset < 6)
                {
                    for (int index = offset; index < end; index++)
                        if (blob[index] != 0) throw new InvalidDataException("Nonzero version padding");
                    yield break;
                }
                var child = ReadBlock(blob, offset, end);
                yield return child;
                offset = Align4(child.End);
            }
        }

        private static string StringValue(byte[] blob, Block block)
        {
            int length = checked(block.ValueLength * 2);
            if (block.Type != 1)
                throw new InvalidDataException("Invalid version string value");
            if (length == 0) return null;
            if (block.ValueStart > block.End - length)
                throw new InvalidDataException("Invalid version string length");
            if (U16(blob, block.ValueStart + length - 2) != 0)
                throw new InvalidDataException("Unterminated version string value");
            string value = Utf16.GetString(blob, block.ValueStart, length - 2);
            if (value.IndexOf('\0') >= 0) throw new InvalidDataException("Embedded terminator in version string");
            return value;
        }

        private static bool IsLanguageCodePage(string key)
        {
            if (key.Length != 8) return false;
            foreach (char character in key)
                if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') ||
                    (character >= 'A' && character <= 'F'))) return false;
            return true;
        }

        private static bool IsContainer(Block block)
        {
            // An empty container's wType does not change the size of its value.
            // Windows tools emit 1; NSIS 3.11 emits 0. Leaf types remain strict.
            return (block.Type == 0 || block.Type == 1) && block.ValueLength == 0;
        }

        private void ReadVersion(byte[] blob, string resource, uint language, int snapshotOffset)
        {
            var root = ReadBlock(blob, 0, blob.Length);
            if (root.Key != "VS_VERSION_INFO" || root.Type != 0 || root.ValueLength != 52 || root.ValueStart > root.End - 52)
                throw new InvalidDataException("Missing VS_FIXEDFILEINFO");
            int value = root.ValueStart;
            uint structureVersion = U32(blob, value + 4);
            // NSIS 3.11 zero-initializes dwStrucVersion. Both known encodings
            // carry the same 52-byte fixed structure; unknown versions fail closed.
            if (U32(blob, value) != 0xFEEF04BD || (structureVersion != 0 && structureVersion != 0x00010000))
                throw new InvalidDataException("Unsupported VS_FIXEDFILEINFO signature/version");
            for (int index = root.End; index < blob.Length; index++)
                if (blob[index] != 0) throw new InvalidDataException("Extra data after VS_VERSION_INFO");
            uint majorMinor = U32(blob, value + 8);
            uint buildRevision = U32(blob, value + 12);
            uint fileFlags = U32(blob, value + 24) & U32(blob, value + 28);
            int before = versions.Count;
            var tableKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var translations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            bool sawStrings = false;
            bool sawVariables = false;
            bool nsisContainers = structureVersion == 0;
            string firstTranslation = null;
            foreach (var child in Children(blob, value + 52, root.End))
            {
                if (child.Key == "VarFileInfo")
                {
                    if (sawVariables || !IsContainer(child))
                        throw new InvalidDataException("Invalid or duplicate VarFileInfo");
                    nsisContainers &= child.Type == 0;
                    sawVariables = true;
                    bool sawTranslation = false;
                    foreach (var translation in Children(blob, child.ValueStart, child.End))
                    {
                        if (sawTranslation || translation.Key != "Translation" || translation.Type != 0 ||
                            translation.ValueLength == 0 || translation.ValueLength % 4 != 0 ||
                            translation.ValueStart > translation.End - translation.ValueLength)
                            throw new InvalidDataException("Invalid version Translation mapping");
                        sawTranslation = true;
                        for (int index = 0; index < translation.ValueLength; index += 4)
                        {
                            string key = String.Format("{0:X4}{1:X4}", U16(blob, translation.ValueStart + index), U16(blob, translation.ValueStart + index + 2));
                            if (firstTranslation == null) firstTranslation = key;
                            if (!translations.Add(key)) throw new InvalidDataException("Duplicate version Translation mapping");
                        }
                    }
                    continue;
                }
                if (child.Key != "StringFileInfo" || !IsContainer(child) || sawStrings)
                    throw new InvalidDataException("Unsupported version information block");
                nsisContainers &= child.Type == 0;
                sawStrings = true;
                foreach (var table in Children(blob, child.ValueStart, child.End))
                {
                    if (!IsContainer(table) || !IsLanguageCodePage(table.Key) || !tableKeys.Add(table.Key))
                        throw new InvalidDataException("Invalid or duplicate version string table");
                    nsisContainers &= table.Type == 0;
                    var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var field in Children(blob, table.ValueStart, table.End))
                    {
                        if (fields.ContainsKey(field.Key)) throw new InvalidDataException("Duplicate version string field");
                        fields.Add(field.Key, StringValue(blob, field));
                    }
                    string fileVersion, productVersion;
                    fields.TryGetValue("FileVersion", out fileVersion);
                    fields.TryGetValue("ProductVersion", out productVersion);
                    var version = Version(resource + "/" + table.Key, majorMinor, buildRevision, fileFlags, fileVersion, productVersion);
                    version.FixedFileInfoOffset = checked(snapshotOffset + value);
                    versions.Add(version);
                }
            }
            // Missing mappings remain unsupported. Cross-resource mappings are
            // validated only after all language resources have been parsed.
            if (!sawVariables || !sawStrings || versions.Count == before || translations.Count == 0)
                throw new InvalidDataException("Missing or inconsistent version Translation/StringTable mapping");
            layouts.Add(language, new VersionLayout {
                Tables = tableKeys, Translations = translations,
                NsisSelectedTable = nsisContainers && tableKeys.Count == 1 && firstTranslation != null &&
                    tableKeys.Contains(firstTranslation) &&
                    Convert.ToUInt32(firstTranslation.Substring(0, 4), 16) == language
            });
        }

        private static ReleaseVersionInfo Version(string resource, uint majorMinor, uint buildRevision,
            uint flags, string fileVersion, string productVersion)
        {
            return new ReleaseVersionInfo {
                Resource = resource, FileVersion = fileVersion, ProductVersion = productVersion,
                FileMajorPart = (int)(majorMinor >> 16), FileMinorPart = (int)(majorMinor & 0xFFFF),
                FileBuildPart = (int)(buildRevision >> 16), FilePrivatePart = (int)(buildRevision & 0xFFFF),
                IsPreRelease = (flags & 2) != 0
            };
        }
    }
}
