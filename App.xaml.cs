using System;
using System.IO;
using System.Windows;
using System.Windows.Threading;

namespace EzShare;

public partial class App : Application
{
    public App()
    {
        DispatcherUnhandledException += App_DispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += CurrentDomain_UnhandledException;
    }

    private void App_DispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        LogError("DispatcherUnhandledException", e.Exception);
        MessageBox.Show($"An error occurred:\n\n{e.Exception.Message}\n\nStack:\n{e.Exception.StackTrace}", "EzShare Error", MessageBoxButton.OK, MessageBoxImage.Error);
        e.Handled = true;
    }

    private void CurrentDomain_UnhandledException(object sender, UnhandledExceptionEventArgs e)
    {
        if (e.ExceptionObject is Exception ex)
        {
            LogError("UnhandledException", ex);
        }
    }

    private static void LogError(string title, Exception ex)
    {
        try
        {
            var logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ezshare_error.log");
            var inner = ex.InnerException != null ? $"\nInner: {ex.InnerException.Message}\n{ex.InnerException.StackTrace}" : "";
            File.AppendAllText(logPath, $"[{DateTime.UtcNow}] {title}: {ex.Message}{inner}\n{ex.StackTrace}\n\n");
        }
        catch { }
    }
}
