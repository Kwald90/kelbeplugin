<?php
/**
 * Admin Budget Management
 *
 * Handles budget administration, analysis, and reporting.
 *
 * @package Kelbe_Project_Tracker
 * @since 1.0.0
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Class KPT_Admin_Budget
 */
class KPT_Admin_Budget {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Admin_Budget
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Admin_Budget
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    /**
     * Constructor
     */
    private function __construct() {
        add_action('admin_menu', array($this, 'add_budget_page'));
        add_action('admin_enqueue_scripts', array($this, 'enqueue_scripts'));
        add_action('wp_ajax_kpt_export_budget_csv', array($this, 'ajax_export_budget_csv'));
    }
    
    /**
     * Add budget page to admin menu
     */
    public function add_budget_page() {
        add_menu_page(
            __('Budget Management', 'kelbe-project-tracker'),
            __('Budgets', 'kelbe-project-tracker'),
            'view_budget',
            'kpt-budget',
            array($this, 'render_budget_page'),
            'dashicons-chart-line',
            31
        );
    }
    
    /**
     * Enqueue admin scripts
     *
     * @param string $hook Current admin page hook
     */
    public function enqueue_scripts($hook) {
        if ('toplevel_page_kpt-budget' !== $hook) {
            return;
        }
        
        wp_enqueue_style(
            'kpt-admin-budget',
            KPT_PLUGIN_URL . 'assets/css/admin-budget.css',
            array(),
            KPT_VERSION
        );
        
        wp_enqueue_script(
            'kpt-admin-budget',
            KPT_PLUGIN_URL . 'assets/js/admin-budget.js',
            array('jquery', 'jquery-ui-datepicker'),
            KPT_VERSION,
            true
        );
        
        wp_localize_script('kpt-admin-budget', 'kptBudget', array(
            'ajax_url' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce('kpt_budget_nonce'),
            'strings' => array(
                'export_success' => __('Budget exported successfully', 'kelbe-project-tracker'),
                'export_error' => __('Error exporting budget', 'kelbe-project-tracker')
            )
        ));
    }
    
    /**
     * Render budget page
     */
    public function render_budget_page() {
        if (!current_user_can('view_budget')) {
            wp_die(__('You do not have sufficient permissions to access this page.', 'kelbe-project-tracker'));
        }
        
        $view = isset($_GET['view']) ? sanitize_key($_GET['view']) : 'overview';
        
        ?>
        <div class="wrap kpt-budget-wrap">
            <h1><?php echo esc_html(get_admin_page_title()); ?></h1>
            
            <ul class="subsubsub">
                <li>
                    <a href="<?php echo esc_url(add_query_arg('view', 'overview')); ?>" 
                       class="<?php echo $view === 'overview' ? 'current' : ''; ?>">
                        <?php _e('Overview', 'kelbe-project-tracker'); ?>
                    </a> |
                </li>
                <li>
                    <a href="<?php echo esc_url(add_query_arg('view', 'projects')); ?>" 
                       class="<?php echo $view === 'projects' ? 'current' : ''; ?>">
                        <?php _e('All Projects', 'kelbe-project-tracker'); ?>
                    </a> |
                </li>
                <li>
                    <a href="<?php echo esc_url(add_query_arg('view', 'analysis')); ?>" 
                       class="<?php echo $view === 'analysis' ? 'current' : ''; ?>">
                        <?php _e('Profit Analysis', 'kelbe-project-tracker'); ?>
                    </a>
                </li>
            </ul>
            
            <div class="clear"></div>
            
            <?php
            switch ($view) {
                case 'projects':
                    $this->render_projects_view();
                    break;
                case 'analysis':
                    $this->render_analysis_view();
                    break;
                default:
                    $this->render_overview();
                    break;
            }
            ?>
        </div>
        <?php
    }
    
    /**
     * Render budget overview
     */
    private function render_overview() {
        global $wpdb;
        
        $table_name = $wpdb->prefix . 'kpt_budgets';
        
        // Get overall statistics
        $stats = $wpdb->get_row(
            "SELECT 
                COUNT(DISTINCT project_id) as total_projects,
                SUM(total_budget) as total_budget,
                SUM(total_spent) as total_spent,
                SUM(total_budget - total_spent) as total_remaining
             FROM $table_name
             WHERE status = 'active'"
        );
        
        $budget_usage_percentage = $stats->total_budget > 0 
            ? ($stats->total_spent / $stats->total_budget) * 100 
            : 0;
        
        // Get project status breakdown
        $status_breakdown = $wpdb->get_results(
            "SELECT 
                p.post_status,
                COUNT(DISTINCT b.project_id) as project_count,
                SUM(b.total_budget) as total_budget,
                SUM(b.total_spent) as total_spent
             FROM $table_name b
             LEFT JOIN {$wpdb->posts} p ON b.project_id = p.ID
             WHERE b.status = 'active'
             GROUP BY p.post_status"
        );
        
        ?>
        <div class="kpt-budget-overview">
            <div class="kpt-budget-stats">
                <div class="kpt-stat-card">
                    <h3><?php _e('Total Budget', 'kelbe-project-tracker'); ?></h3>
                    <p class="kpt-stat-value">$<?php echo number_format($stats->total_budget, 2); ?></p>
                    <p class="kpt-stat-meta"><?php printf(__('Across %d projects', 'kelbe-project-tracker'), $stats->total_projects); ?></p>
                </div>
                
                <div class="kpt-stat-card">
                    <h3><?php _e('Total Spent', 'kelbe-project-tracker'); ?></h3>
                    <p class="kpt-stat-value">$<?php echo number_format($stats->total_spent, 2); ?></p>
                    <p class="kpt-stat-meta"><?php echo number_format($budget_usage_percentage, 1); ?>% <?php _e('of budget', 'kelbe-project-tracker'); ?></p>
                </div>
                
                <div class="kpt-stat-card">
                    <h3><?php _e('Remaining', 'kelbe-project-tracker'); ?></h3>
                    <p class="kpt-stat-value kpt-stat-remaining">$<?php echo number_format($stats->total_remaining, 2); ?></p>
                    <p class="kpt-stat-meta"><?php echo number_format(100 - $budget_usage_percentage, 1); ?>% <?php _e('available', 'kelbe-project-tracker'); ?></p>
                </div>
                
                <div class="kpt-stat-card">
                    <h3><?php _e('Budget Usage', 'kelbe-project-tracker'); ?></h3>
                    <div class="kpt-progress-bar-large">
                        <div class="kpt-progress-fill" style="width: <?php echo min($budget_usage_percentage, 100); ?>%"></div>
                    </div>
                    <p class="kpt-stat-meta"><?php echo number_format($budget_usage_percentage, 1); ?>% <?php _e('utilized', 'kelbe-project-tracker'); ?></p>
                </div>
            </div>
            
            <div class="kpt-budget-breakdown">
                <h2><?php _e('Budget by Project Status', 'kelbe-project-tracker'); ?></h2>
                <table class="wp-list-table widefat fixed striped">
                    <thead>
                        <tr>
                            <th><?php _e('Status', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Projects', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Total Budget', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Total Spent', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Remaining', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Usage', 'kelbe-project-tracker'); ?></th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ($status_breakdown as $status): ?>
                            <?php
                            $remaining = $status->total_budget - $status->total_spent;
                            $usage_percent = $status->total_budget > 0 
                                ? ($status->total_spent / $status->total_budget) * 100 
                                : 0;
                            ?>
                            <tr>
                                <td><strong><?php echo esc_html(ucfirst($status->post_status)); ?></strong></td>
                                <td><?php echo absint($status->project_count); ?></td>
                                <td>$<?php echo number_format($status->total_budget, 2); ?></td>
                                <td>$<?php echo number_format($status->total_spent, 2); ?></td>
                                <td>$<?php echo number_format($remaining, 2); ?></td>
                                <td><?php echo number_format($usage_percent, 1); ?>%</td>
                            </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            </div>
            
            <div class="kpt-budget-actions">
                <button type="button" class="button button-primary" id="export-budget-csv">
                    <?php _e('Export to CSV', 'kelbe-project-tracker'); ?>
                </button>
            </div>
        </div>
        <?php
    }
    
    /**
     * Render projects view
     */
    private function render_projects_view() {
        global $wpdb;
        
        $table_name = $wpdb->prefix . 'kpt_budgets';
        $search = isset($_GET['s']) ? sanitize_text_field($_GET['s']) : '';
        $orderby = isset($_GET['orderby']) ? sanitize_key($_GET['orderby']) : 'project_title';
        $order = isset($_GET['order']) && $_GET['order'] === 'asc' ? 'ASC' : 'DESC';
        
        $query = "SELECT 
                    b.*,
                    p.post_title as project_title,
                    p.post_status
                  FROM $table_name b
                  LEFT JOIN {$wpdb->posts} p ON b.project_id = p.ID
                  WHERE 1=1";
        
        if (!empty($search)) {
            $query .= $wpdb->prepare(" AND p.post_title LIKE %s", '%' . $wpdb->esc_like($search) . '%');
        }
        
        $allowed_orderby = array('project_title', 'total_budget', 'total_spent', 'status');
        if (in_array($orderby, $allowed_orderby)) {
            $query .= " ORDER BY " . $orderby . " " . $order;
        }
        
        $budgets = $wpdb->get_results($query);
        
        ?>
        <div class="kpt-budget-projects">
            <form method="get" class="kpt-budget-search">
                <input type="hidden" name="page" value="kpt-budget">
                <input type="hidden" name="view" value="projects">
                <input type="search" name="s" value="<?php echo esc_attr($search); ?>" 
                       placeholder="<?php _e('Search projects...', 'kelbe-project-tracker'); ?>">
                <button type="submit" class="button"><?php _e('Search', 'kelbe-project-tracker'); ?></button>
            </form>
            
            <table class="wp-list-table widefat fixed striped">
                <thead>
                    <tr>
                        <th><?php echo $this->get_sortable_header('project_title', __('Project', 'kelbe-project-tracker')); ?></th>
                        <th><?php echo $this->get_sortable_header('total_budget', __('Budget', 'kelbe-project-tracker')); ?></th>
                        <th><?php echo $this->get_sortable_header('total_spent', __('Spent', 'kelbe-project-tracker')); ?></th>
                        <th><?php _e('Remaining', 'kelbe-project-tracker'); ?></th>
                        <th><?php _e('Usage', 'kelbe-project-tracker'); ?></th>
                        <th><?php _e('Profit Margin', 'kelbe-project-tracker'); ?></th>
                        <th><?php echo $this->get_sortable_header('status', __('Status', 'kelbe-project-tracker')); ?></th>
                        <th><?php _e('Actions', 'kelbe-project-tracker'); ?></th>
                    </tr>
                </thead>
                <tbody>
                    <?php if (empty($budgets)): ?>
                        <tr>
                            <td colspan="8"><?php _e('No budgets found.', 'kelbe-project-tracker'); ?></td>
                        </tr>
                    <?php else: ?>
                        <?php foreach ($budgets as $budget): ?>
                            <?php
                            $remaining = $budget->total_budget - $budget->total_spent;
                            $usage_percent = $budget->total_budget > 0 
                                ? ($budget->total_spent / $budget->total_budget) * 100 
                                : 0;
                            $profit_margin = $budget->total_budget > 0 
                                ? (($budget->total_budget - $budget->total_spent) / $budget->total_budget) * 100 
                                : 0;
                            ?>
                            <tr>
                                <td>
                                    <strong>
                                        <a href="<?php echo esc_url(get_edit_post_link($budget->project_id)); ?>">
                                            <?php echo esc_html($budget->project_title); ?>
                                        </a>
                                    </strong>
                                </td>
                                <td>$<?php echo number_format($budget->total_budget, 2); ?></td>
                                <td>$<?php echo number_format($budget->total_spent, 2); ?></td>
                                <td class="<?php echo $remaining < 0 ? 'kpt-over-budget' : ''; ?>">
                                    $<?php echo number_format($remaining, 2); ?>
                                </td>
                                <td>
                                    <div class="kpt-progress-bar-small">
                                        <div class="kpt-progress-fill <?php echo $usage_percent > 90 ? 'kpt-warning' : ''; ?>" 
                                             style="width: <?php echo min($usage_percent, 100); ?>%"></div>
                                    </div>
                                    <span class="kpt-progress-text"><?php echo number_format($usage_percent, 1); ?>%</span>
                                </td>
                                <td>
                                    <span class="kpt-profit-margin <?php echo $profit_margin < 10 ? 'kpt-low-margin' : ''; ?>">
                                        <?php echo number_format($profit_margin, 1); ?>%
                                    </span>
                                </td>
                                <td>
                                    <span class="kpt-status-badge kpt-status-<?php echo esc_attr($budget->status); ?>">
                                        <?php echo esc_html(ucfirst($budget->status)); ?>
                                    </span>
                                </td>
                                <td>
                                    <a href="<?php echo esc_url(get_edit_post_link($budget->project_id)); ?>" 
                                       class="button button-small">
                                        <?php _e('View Details', 'kelbe-project-tracker'); ?>
                                    </a>
                                </td>
                            </tr>
                        <?php endforeach; ?>
                    <?php endif; ?>
                </tbody>
            </table>
        </div>
        <?php
    }
    
    /**
     * Render profit analysis view
     */
    private function render_analysis_view() {
        global $wpdb;
        
        $table_name = $wpdb->prefix . 'kpt_budgets';
        
        // Get profit margin analysis
        $analysis = $wpdb->get_results(
            "SELECT 
                CASE 
                    WHEN total_budget = 0 THEN 'N/A'
                    WHEN ((total_budget - total_spent) / total_budget * 100) >= 30 THEN 'High (30%+)'
                    WHEN ((total_budget - total_spent) / total_budget * 100) >= 15 THEN 'Medium (15-30%)'
                    WHEN ((total_budget - total_spent) / total_budget * 100) >= 0 THEN 'Low (0-15%)'
                    ELSE 'Over Budget'
                END as margin_category,
                COUNT(*) as project_count,
                SUM(total_budget) as total_budget,
                SUM(total_spent) as total_spent,
                SUM(total_budget - total_spent) as total_profit
             FROM $table_name
             WHERE status = 'active'
             GROUP BY margin_category
             ORDER BY 
                CASE margin_category
                    WHEN 'High (30%+)' THEN 1
                    WHEN 'Medium (15-30%)' THEN 2
                    WHEN 'Low (0-15%)' THEN 3
                    WHEN 'Over Budget' THEN 4
                    ELSE 5
                END"
        );
        
        // Get top performing projects
        $top_projects = $wpdb->get_results(
            "SELECT 
                b.*,
                p.post_title as project_title,
                ((b.total_budget - b.total_spent) / b.total_budget * 100) as profit_margin_percent
             FROM $table_name b
             LEFT JOIN {$wpdb->posts} p ON b.project_id = p.ID
             WHERE b.status = 'active' AND b.total_budget > 0
             ORDER BY profit_margin_percent DESC
             LIMIT 10"
        );
        
        // Get projects at risk (over 90% budget used)
        $at_risk_projects = $wpdb->get_results(
            "SELECT 
                b.*,
                p.post_title as project_title,
                (b.total_spent / b.total_budget * 100) as budget_usage_percent
             FROM $table_name b
             LEFT JOIN {$wpdb->posts} p ON b.project_id = p.ID
             WHERE b.status = 'active' 
             AND b.total_budget > 0 
             AND (b.total_spent / b.total_budget * 100) >= 90
             ORDER BY budget_usage_percent DESC"
        );
        
        ?>
        <div class="kpt-profit-analysis">
            <div class="kpt-analysis-section">
                <h2><?php _e('Profit Margin Distribution', 'kelbe-project-tracker'); ?></h2>
                <table class="wp-list-table widefat fixed striped">
                    <thead>
                        <tr>
                            <th><?php _e('Margin Category', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Projects', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Total Budget', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Total Spent', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Total Profit', 'kelbe-project-tracker'); ?></th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ($analysis as $category): ?>
                            <tr>
                                <td><strong><?php echo esc_html($category->margin_category); ?></strong></td>
                                <td><?php echo absint($category->project_count); ?></td>
                                <td>$<?php echo number_format($category->total_budget, 2); ?></td>
                                <td>$<?php echo number_format($category->total_spent, 2); ?></td>
                                <td class="<?php echo $category->total_profit < 0 ? 'kpt-negative-profit' : 'kpt-positive-profit'; ?>">
                                    $<?php echo number_format($category->total_profit, 2); ?>
                                </td>
                            </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            </div>
            
            <div class="kpt-analysis-section">
                <h2><?php _e('Top Performing Projects', 'kelbe-project-tracker'); ?></h2>
                <table class="wp-list-table widefat fixed striped">
                    <thead>
                        <tr>
                            <th><?php _e('Project', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Budget', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Spent', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Profit', 'kelbe-project-tracker'); ?></th>
                            <th><?php _e('Margin %', 'kelbe-project-tracker'); ?></th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php if (empty($top_projects)): ?>
                            <tr>
                                <td colspan="5"><?php _e('No projects found.', 'kelbe-project-tracker'); ?></td>
                            </tr>
                        <?php else: ?>
                            <?php foreach ($top_projects as $project): ?>
                                <?php
                                $profit = $project->total_budget - $project->total_spent;
                                ?>
                                <tr>
                                    <td>
                                        <a href="<?php echo esc_url(get_edit_post_link($project->project_id)); ?>">
                                            <?php echo esc_html($project->project_title); ?>
                                        </a>
                                    </td>
                                    <td>$<?php echo number_format($project->total_budget, 2); ?></td>
                                    <td>$<?php echo number_format($project->total_spent, 2); ?></td>
                                    <td class="kpt-positive-profit">$<?php echo number_format($profit, 2); ?></td>
                                    <td>
                                        <span class="kpt-profit-badge kpt-high-profit">
                                            <?php echo number_format($project->profit_margin_percent, 1); ?>%
                                        </span>
                                    </td>
                                </tr>
                            <?php endforeach; ?>
                        <?php endif; ?>
                    </tbody>
                </table>
            </div>
            
            <?php if (!empty($at_risk_projects)): ?>
                <div class="kpt-analysis-section kpt-alert-section">
                    <h2><?php _e('Projects at Risk', 'kelbe-project-tracker'); ?></h2>
                    <p class="description"><?php _e('Projects that have used 90% or more of their budget', 'kelbe-project-tracker'); ?></p>
                    <table class="wp-list-table widefat fixed striped">
                        <thead>
                            <tr>
                                <th><?php _e('Project', 'kelbe-project-tracker'); ?></th>
                                <th><?php _e('Budget', 'kelbe-project-tracker'); ?></th>
                                <th><?php _e('Spent', 'kelbe-project-tracker'); ?></th>
                                <th><?php _e('Remaining', 'kelbe-project-tracker'); ?></th>
                                <th><?php _e('Usage %', 'kelbe-project-tracker'); ?></th>
                            </tr>
                        </thead>
                        <tbody>
                            <?php foreach ($at_risk_projects as $project): ?>
                                <?php
                                $remaining = $project->total_budget - $project->total_spent;
                                ?>
                                <tr class="kpt-warning-row">
                                    <td>
                                        <strong>
                                            <a href="<?php echo esc_url(get_edit_post_link($project->project_id)); ?>">
                                                <?php echo esc_html($project->project_title); ?>
                                            </a>
                                        </strong>
                                    </td>
                                    <td>$<?php echo number_format($project->total_budget, 2); ?></td>
                                    <td>$<?php echo number_format($project->total_spent, 2); ?></td>
                                    <td class="<?php echo $remaining < 0 ? 'kpt-over-budget' : ''; ?>">
                                        $<?php echo number_format($remaining, 2); ?>
                                    </td>
                                    <td>
                                        <span class="kpt-warning-badge">
                                            <?php echo number_format($project->budget_usage_percent, 1); ?>%
                                        </span>
                                    </td>
                                </tr>
                            <?php endforeach; ?>
                        </tbody>
                    </table>
                </div>
            <?php endif; ?>
        </div>
        <?php
    }
    
    /**
     * AJAX export budget to CSV
     */
    public function ajax_export_budget_csv() {
        check_ajax_referer('kpt_budget_nonce', 'nonce');
        
        if (!current_user_can('view_budget')) {
            wp_send_json_error(array('message' => __('Permission denied', 'kelbe-project-tracker')));
        }
        
        global $wpdb;
        $table_name = $wpdb->prefix . 'kpt_budgets';
        
        $budgets = $wpdb->get_results(
            "SELECT 
                b.*,
                p.post_title as project_title,
                p.post_status
             FROM $table_name b
             LEFT JOIN {$wpdb->posts} p ON b.project_id = p.ID
             ORDER BY p.post_title ASC"
        );
        
        $filename = 'kpt-budget-export-' . date('Y-m-d') . '.csv';
        
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename=' . $filename);
        header('Pragma: no-cache');
        header('Expires: 0');
        
        $output = fopen('php://output', 'w');
        
        // Add BOM for Excel UTF-8 support
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));
        
        // Headers
        fputcsv($output, array(
            __('Project', 'kelbe-project-tracker'),
            __('Status', 'kelbe-project-tracker'),
            __('Budget', 'kelbe-project-tracker'),
            __('Spent', 'kelbe-project-tracker'),
            __('Remaining', 'kelbe-project-tracker'),
            __('Usage %', 'kelbe-project-tracker'),
            __('Profit Margin %', 'kelbe-project-tracker')
        ));
        
        // Data rows
        foreach ($budgets as $budget) {
            $remaining = $budget->total_budget - $budget->total_spent;
            $usage_percent = $budget->total_budget > 0 
                ? ($budget->total_spent / $budget->total_budget) * 100 
                : 0;
            $profit_margin = $budget->total_budget > 0 
                ? (($budget->total_budget - $budget->total_spent) / $budget->total_budget) * 100 
                : 0;
            
            fputcsv($output, array(
                $budget->project_title,
                ucfirst($budget->post_status),
                number_format($budget->total_budget, 2),
                number_format($budget->total_spent, 2),
                number_format($remaining, 2),
                number_format($usage_percent, 2),
                number_format($profit_margin, 2)
            ));
        }
        
        fclose($output);
        exit;
    }
    
    /**
     * Get sortable table header
     *
     * @param string $column Column name
     * @param string $label Column label
     * @return string
     */
    private function get_sortable_header($column, $label) {
        $current_orderby = isset($_GET['orderby']) ? sanitize_key($_GET['orderby']) : '';
        $current_order = isset($_GET['order']) && $_GET['order'] === 'asc' ? 'asc' : 'desc';
        
        $new_order = ($current_orderby === $column && $current_order === 'desc') ? 'asc' : 'desc';
        
        $url = add_query_arg(array(
            'orderby' => $column,
            'order' => $new_order
        ));
        
        $arrow = '';
        if ($current_orderby === $column) {
            $arrow = $current_order === 'asc' ? ' ↑' : ' ↓';
        }
        
        return '<a href="' . esc_url($url) . '">' . esc_html($label) . $arrow . '</a>';
    }
}

// Initialize
KPT_Admin_Budget::get_instance();
