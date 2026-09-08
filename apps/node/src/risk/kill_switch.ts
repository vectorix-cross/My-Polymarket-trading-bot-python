export class KillSwitch {
  private enabled = false;

  activate(): void {
    this.enabled = true;
  }

  deactivate(): void {
    this.enabled = false;
  }

  isActive(): boolean {
    return this.enabled;
  }
}
