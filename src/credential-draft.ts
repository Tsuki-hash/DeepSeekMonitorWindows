/** Memory-only draft generations. Equal text is not the same user edit. */
export type CredentialSnapshot = { value: string; revision: number };

export class CredentialDraft {
  value = "";
  revision = 0;
  committedRevision = 0;

  edit(value: string): void {
    this.value = value;
    this.revision += 1;
  }

  snapshot(): CredentialSnapshot {
    return { value: this.value, revision: this.revision };
  }

  get dirty(): boolean {
    return (
      this.value.trim().length > 0 && this.revision !== this.committedRevision
    );
  }

  clear(): void {
    this.edit("");
    this.committedRevision = this.revision;
  }

  commit(revision: number): boolean {
    this.committedRevision = Math.max(this.committedRevision, revision);
    if (this.revision !== revision) return false;
    this.clear();
    return true;
  }
}
