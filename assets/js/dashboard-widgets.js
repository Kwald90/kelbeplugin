/**
 * Dashboard Widgets JavaScript
 *
 * @package Kelbe_Project_Tracker
 */

(function($) {
    'use strict';
    
    $(document).ready(function() {
        
        // Auto-refresh dashboard widgets every 5 minutes
        setInterval(function() {
            refreshDashboardWidgets();
        }, 300000);
        
        function refreshDashboardWidgets() {
            $('.kpt-widget-list').each(function() {
                var $widget = $(this).closest('.inside');
                $widget.css('opacity', '0.5');
                
                // Note: WordPress dashboard widgets auto-refresh via AJAX
                // This is a placeholder for custom refresh logic if needed
            });
        }
    });
    
})(jQuery);
